const React = require('react')
const propTypes = require('prop-types')
const { Text, Box } = require('ink')

function Init(props) {
  const { url } = props

  return (
    <Box marginTop={1}>
      <Text bold>Clonning:</Text> {url}
    </Box>
  )
}

Init.propTypes = {
  url: propTypes.string
}

module.exports = Init
