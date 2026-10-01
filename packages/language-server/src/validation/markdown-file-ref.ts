// SPDX-License-Identifier: MIT

import { type ValidationCheck, AstUtils } from 'langium'
import { type LikeC4LangiumDocument, ast } from '../ast'
import type { LikeC4Services } from '../module'
import { tryOrLog } from './_shared'

export const markdownFileRefChecks = (
  _services: LikeC4Services,
): ValidationCheck<ast.MarkdownFileRef> => {
  return tryOrLog((node, accept) => {
    if (!node.path || !node.path.trim()) {
      accept('error', 'External markdown file path must not be empty', {
        node,
        property: 'path',
      })
      return
    }

    const doc = AstUtils.getDocument(node) as LikeC4LangiumDocument
    const resolution = doc.c4ExternalMarkdown?.refs.get(node)

    if (!resolution) {
      return
    }

    switch (resolution.kind) {
      case 'ok':
        return
      case 'empty-path':
        accept('error', 'External markdown file path must not be empty', {
          node,
          property: 'path',
        })
        return
      case 'invalid-scheme':
        accept(
          'error',
          `External markdown references do not support the "${resolution.scheme}" scheme. Use a relative path, "/absolute" (from project folder), or a "@alias/..." path.`,
          { node, property: 'path' },
        )
        return
      case 'alias-missing':
        accept(
          'error',
          `File alias "${resolution.aliasName}" is not defined in likec4.config fileAliases`,
          { node, property: 'path' },
        )
        return
      case 'not-found':
        accept(
          'error',
          `External markdown file not found: ${resolution.absoluteUri}`,
          { node, property: 'path' },
        )
        return
      case 'read-error':
        accept(
          'error',
          `Failed to read external markdown file: ${resolution.message}`,
          { node, property: 'path' },
        )
        return
      case 'no-filesystem':
        accept(
          'error',
          'External markdown file references require a file system (not available in this context)',
          { node, property: 'path' },
        )
        return
    }
  })
}
