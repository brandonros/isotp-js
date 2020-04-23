const highNibble = (b) => (((b) >> 4) & 0x0F)
const lowNibble = (b) => ((b) & 0x0F)

const IsotpReaderWriter = function (mode, requestArbitrationId, replyArbitrationId, sendCanFrame, recvCanFrame, onMessage) {
  this.mode = mode
  this.requestArbitrationId = requestArbitrationId
  this.replyArbitrationId = replyArbitrationId
  this.sendCanFrame = sendCanFrame
  this.recvCanFrame = recvCanFrame
  this.onMessage = onMessage
  this.rxQueue = []
  this.txQueue = []
  this.rxState = 'ISOTP_IDLE'
  this.txState = 'ISOTP_IDLE'
  this.rxSequenceNumber = 0x21
  this.rxConsecutiveFrames = []
  this.rxExpectedSize = 0
  this.rxFirstFrame = null
  this.txFirstFrame = null
  this.txTimer = null
  this.rxTimer = null
}

IsotpReaderWriter.prototype.resetRxState = function () {
  this.rxState = 'ISOTP_IDLE'
  this.rxExpectedSize = 0
  this.rxSequenceNumber = 0x21
  this.rxConsecutiveFrames = []
  this.rxFirstFrame = null
  this.rxTimer = null
}

IsotpReaderWriter.prototype.initLoop = async function () {
  // recv
  let isRecvIntervalInProgress = false
  setInterval(async () => {
    if (isRecvIntervalInProgress) {
      console.debug('not doing recv tick; locked')
      return
    }
    isRecvIntervalInProgress = true
    await this.recv()
    isRecvIntervalInProgress = false
  }, 50)
  // send
  let isSendIntervalInProgress = false
  setInterval(async () => {
    if (isSendIntervalInProgress) {
      console.debug('not doing send tick; locked')
      return
    }
    isSendIntervalInProgress = true
    await this.send()
    isSendIntervalInProgress = false
  }, 50)
  // fill recv queue
  for (;;) {
    await this.fillRecvQueue()
  }
}


IsotpReaderWriter.prototype.fillRecvQueue = async function () {
  const { arbitrationId, payload } = await this.recvCanFrame()
  const shouldDropFrame = (this.mode === 'tester' && arbitrationId !== this.replyArbitrationId) ||
    (this.mode === 'device' && arbitrationId !== this.requestArbitrationId)
  if (shouldDropFrame) {
    console.debug(`dropping frame; arbitrationId = ${arbitrationId.toString(16).padStart(3, '0')}`)
  } else {
    console.debug(`pushing to rxQueue`)
    this.rxQueue.push(payload)
  }
}

IsotpReaderWriter.prototype.rebuildMultiFrameMessage = function () {
  const output = []
  // skip first 2 bytes of first frame
  for (let i = 2; i < this.rxFirstFrame.length; ++i) {
    output.push(this.rxFirstFrame[i])
  }
  this.rxConsecutiveFrames.forEach(frame => {
    // skip first byte of consecutive frames
    for (let i = 1; i < frame.length; ++i) {
      output.push(frame[i])
    }
  })
  const isotpPayload = output.slice(0, this.rxExpectedSize)
  const serviceId = isotpPayload[0]
  const data = isotpPayload.slice(1)
  return {
    serviceId,
    data
  }
}

IsotpReaderWriter.prototype.rebuildSingleFrameMessage = function (payload) {
  const length = payload[0]
  const serviceId = payload[1]
  const data = payload.slice(2, length + 1)
  return {
    serviceId,
    data
  }
}

IsotpReaderWriter.prototype.sendFlowControlFrame = async function () {
  const flowControlFrame = new Uint8Array([0x30, 0x00, 0x00, 0x55, 0x55, 0x55, 0x55, 0x55])
  return this.sendCanFrame(this.mode === 'tester' ? this.requestArbitrationId : this.replyArbitrationId, flowControlFrame)
}

IsotpReaderWriter.prototype.recv = async function () {
  if (!this.rxQueue.length) {
    console.debug(`exiting recv; nothing in queue; rxState = ${this.rxState}`)
    return
  }
  console.debug(`recv tick rxState = ${this.rxState}`)
  if (this.rxState === 'ISOTP_IDLE') {
    this.rxState = 'ISOTP_WAIT_DATA'
  } else if (this.rxState === 'ISOTP_WAIT_DATA') {
    const frame = this.rxQueue.shift()
    const pci = highNibble(frame[0])
    if (pci === 0x00) { // receive single frame and be done
      this.onMessage(this.rebuildSingleFrameMessage(frame))
      this.rxState = 'ISOTP_IDLE'
    } else if (pci === 0x01) { // set first frame then send flow control frame
      this.rxFirstFrame = frame
      this.rxExpectedSize = (lowNibble(frame[0]) << 8) + frame[1]
      this.rxSequenceNumber = 0x21
      this.rxConsecutiveFrames = []
      await this.sendFlowControlFrame()
      this.rxTimer = setTimeout(() => {
        if (this.rxState === 'ISOTP_WAIT_DATA') {
          console.deug('took too long to receive')
          this.resetRxState()
          // TODO: send failure?
          return
        }
      }, 1000)
    } else if (pci === 0x02) { // receive consecutive frames
      const sequenceNumber = frame[0]
      if (sequenceNumber !== this.rxSequenceNumber) { // fail if we get an out of sequence frame
        console.debug('received unexpected sequence number')
        clearTimeout(this.rxTimer)
        this.resetRxState()
        // TODO: send failure?
        return
      }
      // push frame for rebuilding later
      this.rxSequenceNumber += 1
      if (this.rxSequenceNumber === 0x30) {
        this.rxSequenceNumber = 0x20
      }
      this.rxConsecutiveFrames.push(frame)
      // see if we are done receiving
      const currentSize = 6 + this.rxConsecutiveFrames.length * 7 // 6 from first frame, 7 from all conseuctive frames
      if (currentSize >= this.rxExpectedSize) {
        this.onMessage(this.rebuildMultiFrameMessage())
        clearTimeout(this.rxTimer)
        this.resetRxState()
      }
    } else if (pci === 0x03) { // receive flow control frames
      if (this.txState === 'ISOTP_WAIT_FC') {
        console.debug('was waiting for flow control; got flow control frame')
        this.txState = 'ISOTP_SENDING'
      } else {
        console.debug('received unexpected flow control frame')
      }
      this.rxState = 'ISOTP_IDLE'
    }
  }
}

IsotpReaderWriter.prototype.send = async function () {
  if (!this.txQueue.length) {
    console.debug(`exiting send; nothing in queue; txState = ${this.txState}`)
    if (this.txState === 'ISOTP_SENDING') {
      this.txState = 'ISOTP_IDLE'
    }
    return
  }
  if (this.txState === 'ISOTP_IDLE') {
    this.txState = 'ISOTP_SENDING'
  } else if (this.txState === 'ISOTP_WAIT_FC') {
    console.debug('waiting for flow control before sending anymore')
  } else if (this.txState === 'ISOTP_SENDING') {
    console.debug('sending frame')
    const frame = this.txQueue.shift()
    await this.sendCanFrame(this.mode === 'tester' ? this.requestArbitrationId : this.replyArbitrationId, frame)
    const pci = highNibble(frame[0])
    if (pci === 0x00) { // send single frame then be done
      this.txState = 'ISOTP_IDLE'
    } else if (pci === 0x01) { // send first frame then wait up to 1 second for ISOTP_WAIT_FC
      this.txState = 'ISOTP_WAIT_FC'
      setTimeout(() => {
        if (this.txState === 'ISOTP_WAIT_FC') {
         console.debug('failed to receive flow control, took too long')
         this.txState = 'ISOTP_IDLE'
         this.txTimer = null
         this.txQueue = []
         // TODO: send failure?
        }
      }, 1000)
    }
  }
}

IsotpReaderWriter.prototype.buildSingleFrame = function (serviceId, data) {
  const frame = [data.length + 1, serviceId]
  for (let i = 0; i < data.length; ++i) {
    frame[i + 2] = data[i]
  }
  for (let i = frame.length; i < 8; ++i) {
    frame.push(0x55) // padding
  }
  return frame
}

IsotpReaderWriter.prototype.buildFirstFrame = function (serviceId, data) {
  const responseLength = data.length + 1 // add a byte for response SID
  const firstFrameData = data.slice(0, 5)
  const firstFrameHeader = [
    (0x01 << 4) ^ (responseLength >> 8),
    responseLength & 0xFF,
    serviceId
  ]
  return [].concat(
    firstFrameHeader,
    firstFrameData
  )
}

IsotpReaderWriter.prototype.buildConsecutiveFrame = function (consecutiveFrameCounter, remainingData) {
  let frameData = remainingData.slice(0, 7)
  // Pad last frame
  if (frameData.length < 7) {
    const paddingLength = 7 - frameData.length
    const padding = new Array(paddingLength).fill(0x55)
    frameData = [].concat(frameData, padding)
  }
  const consecutiveFrameHeader = [
    (0x02 << 4) ^ consecutiveFrameCounter
  ]
  return [].concat(
    consecutiveFrameHeader,
    frameData
  )
}

IsotpReaderWriter.prototype.convertPduToFrames = function (serviceId, data) {
  if (data.length <= 6) {
    return [this.buildSingleFrame(serviceId, data)]
  }
  const frames = []
  frames.push(this.buildFirstFrame(serviceId, data))
  let remainingData = data.slice(5) // first frame data length = 5
  const numConsecutiveFrames = Math.ceil(remainingData.length / 7)
  let consecutiveFrameCounter = 1
  for (let i = 0; i < numConsecutiveFrames; ++i) {
    frames.push(this.buildConsecutiveFrame(consecutiveFrameCounter, remainingData))
    consecutiveFrameCounter += 1
    // Wrap consecutive frame counter
    if (consecutiveFrameCounter === 10) {
      consecutiveFrameCounter = 0
    }
    remainingData = remainingData.slice(7)
  }
  return frames
}

IsotpReaderWriter.prototype.queueSend = function (serviceId, data) {
  const frames = this.convertPduToFrames(serviceId, data)
  for (let i = 0; i < frames.length; ++i) {
    this.txQueue.push(frames[i])
  }
}

module.exports = IsotpReaderWriter
