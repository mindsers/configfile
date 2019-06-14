'use strict'

require = require('esm')(module) // eslint-disable-line no-global-assign

const { env: { NODE_ENV } } = process

module.exports = require(NODE_ENV === 'test' ? './tests.js' : './main.js')
