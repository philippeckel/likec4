import z from 'zod/v4'

// Key must be prefixed with "@" and contain only allowed characters
const FILE_ALIAS_KEY_REGEX = /^@[A-Za-z0-9_-]*$/
// Relative path (no leading slash, drive letter, or protocol)
const FILE_ALIAS_VALUE_REGEX = /^(?!\/|[A-Za-z]:[\\\/])(?!.*:\/\/).*$/

const FileAliasKey = z
  .string()
  .min(1, 'File alias key cannot be empty')
  .regex(
    FILE_ALIAS_KEY_REGEX,
    'File alias key must match /^@\\w+$/',
  )

const FileAliasValue = z
  .string()
  .min(1, 'File alias value cannot be empty')
  .regex(
    FILE_ALIAS_VALUE_REGEX,
    'File alias value must be a relative path (no leading slash or protocol)',
  )

export const FileAliasesSchema = z.record(
  FileAliasKey,
  FileAliasValue,
).meta({
  id: 'FileAliases',
  description:
    'Map of file alias prefixes to relative paths, used to resolve `description file "@alias/..."` references (keys must match /^@\\w+$/; values must be relative paths without protocol or leading slash).',
})
