const assert = require('assert')
const IsotpReaderWriter = require('../index.js')
const mode = 'tester'
const requestArbitrationId = 0x7E5
const replyArbitrationId = 0x7ED
const mockResponses = []
let counter = 0
const sendCanFrame = function (arbitrationId, payload) {
  console.debug(`sendCanFrame arbitrationId = ${arbitrationId.toString(16).padStart(3, '0')} payload = ${Buffer.from(payload).toString('hex')}`)
  if (counter === 0) {
    mockResponses.push({
      arbitrationId: 0x7ED,
      payload: [0x30, 0x00, 0x00, 0x55, 0x55, 0x55, 0x55, 0x55]
    })
    counter += 1
  } else if (counter === 1) {
    mockResponses.push({
      arbitrationId: 0x7ED,
      payload: [0x02, 0x71, 0x00, 0x55, 0x55, 0x55, 0x55, 0x55]
    })
    counter += 1
  }
}
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const recvCanFrame = async function () {
  for (;;) {
    await delay(100)
    if (mockResponses.length) {
      const mockResponse = mockResponses.shift()
      return mockResponse
    }
  }
}
const onMessage = function (message) {
  const { serviceId, data } = message
  console.debug(`onMessage serviceId = ${serviceId.toString(16).padStart(2, '0')} data = ${Buffer.from(data).toString('hex')}`)
  assert(serviceId === 0x71)
  assert(Buffer.from(data).toString('hex') === '00')
  process.exit(0)
}
const isotpReaderWriter = new IsotpReaderWriter(mode, requestArbitrationId, replyArbitrationId, sendCanFrame, recvCanFrame, onMessage)
isotpReaderWriter.queueSend(0x31, [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])
isotpReaderWriter.initLoop()