const assert = require('assert')
const IsotpReaderWriter = require('../index.js')
const mode = 'device'
const requestArbitrationId = 0x7E5
const replyArbitrationId = 0x7ED
const mockResponses = [
  { arbitrationId: 0x7E5, payload: [0x10, 0x0a, 0x31, 0x00, 0x01, 0x02, 0x03, 0x04] },
  { arbitrationId: 0x7E5, payload: [0x21, 0x05, 0x06, 0x07, 0x08, 0x55, 0x55, 0x55] },
]
let counter = 0
const sendCanFrame = function (arbitrationId, payload) {
  console.debug(`sendCanFrame arbitrationId = ${arbitrationId.toString(16).padStart(3, '0')} payload = ${Buffer.from(payload).toString('hex')}`)
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
  assert(serviceId === 0x31)
  assert(Buffer.from(data).toString('hex') === '000102030405060708')
  process.exit(0)
}
const isotpReaderWriter = new IsotpReaderWriter(mode, requestArbitrationId, replyArbitrationId, sendCanFrame, recvCanFrame, onMessage)
isotpReaderWriter.initLoop()