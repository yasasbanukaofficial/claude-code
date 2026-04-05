import * as React from 'react'
import { Box, Text } from '../../ink.js'

export type ClawdPose =
  | 'default'
  | 'arms-up'
  | 'look-left'
  | 'look-right'

type Props = {
  pose?: ClawdPose
}

export function Clawd(_props: Props) {
  return (
    <Box flexDirection="column">
      <Text color="clawd_body">╭─────────╮</Text>
      <Text color="clawd_body" backgroundColor="clawd_background">
        │   JAY   │
      </Text>
      <Text color="clawd_body">╰─────────╯</Text>
    </Box>
  )
}
