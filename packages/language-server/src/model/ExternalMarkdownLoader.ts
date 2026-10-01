// SPDX-License-Identifier: MIT

import { AstUtils, URI, UriUtils } from 'langium'
import { hasLeadingSlash, hasProtocol, isRelative, joinRelativeURL, joinURL } from 'ufo'
import { type LikeC4LangiumDocument, type ParsedLikeC4LangiumDocument, ast, isLikeC4UserDocument } from '../ast'
import { logger as rootLogger } from '../logger'
import type { LikeC4Services } from '../module'

const logger = rootLogger.getChild('external-md')

export type ExternalMarkdownResolution =
  | { kind: 'ok'; absoluteUri: string; content: string }
  | { kind: 'not-found'; absoluteUri: string }
  | { kind: 'read-error'; absoluteUri: string; message: string }
  | { kind: 'alias-missing'; aliasName: string }
  | { kind: 'no-filesystem'; absoluteUri?: string }
  | { kind: 'invalid-scheme'; scheme: string }
  | { kind: 'empty-path' }

export interface ExternalMarkdownCache {
  readonly refs: WeakMap<ast.MarkdownFileRef, ExternalMarkdownResolution>
  readonly dependencies: ReadonlySet<string>
}

const EMPTY_CACHE: ExternalMarkdownCache = {
  refs: new WeakMap(),
  dependencies: new Set(),
}

declare module '../ast' {
  export interface LikeC4DocumentProps {
    c4ExternalMarkdown?: ExternalMarkdownCache
  }
}

/**
 * Resolves `description file "..."` references to disk content before the sync model parser runs.
 */
export class ExternalMarkdownLoader {
  // Map referenced external .md URI (normalized string) → set of .c4 document URIs depending on it.
  private readonly dependents = new Map<string, Set<string>>()

  constructor(private readonly services: LikeC4Services) {}

  getCache(doc: ParsedLikeC4LangiumDocument): ExternalMarkdownCache {
    return doc.c4ExternalMarkdown ?? EMPTY_CACHE
  }

  /** URIs of `.c4` documents that reference the given external markdown URI. */
  dependentsOf(mdUri: string): ReadonlySet<string> {
    return this.dependents.get(mdUri) ?? new Set()
  }

  async loadForDocument(doc: LikeC4LangiumDocument): Promise<void> {
    if (!isLikeC4UserDocument(doc)) {
      return
    }
    const refs = this.collectRefs(doc)
    if (refs.length === 0) {
      this.updateDependencies(doc, new Set())
      doc.c4ExternalMarkdown = EMPTY_CACHE
      return
    }

    const project = this.services.shared.workspace.ProjectsManager.getProject(doc)
    const fs = this.services.shared.workspace.FileSystemProvider
    const resolutions = new WeakMap<ast.MarkdownFileRef, ExternalMarkdownResolution>()
    const dependencies = new Set<string>()

    await Promise.all(refs.map(async ref => {
      const resolved = this.resolveRef(ref, doc, project)
      if (resolved.kind === 'resolved') {
        try {
          const content = await fs.readFile(URI.parse(resolved.absoluteUri))
          resolutions.set(ref, { kind: 'ok', absoluteUri: resolved.absoluteUri, content })
          dependencies.add(resolved.absoluteUri)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (isNoFilesystem(message)) {
            resolutions.set(ref, { kind: 'no-filesystem', absoluteUri: resolved.absoluteUri })
          } else if (isNotFound(error, message)) {
            resolutions.set(ref, { kind: 'not-found', absoluteUri: resolved.absoluteUri })
            dependencies.add(resolved.absoluteUri)
          } else {
            resolutions.set(ref, { kind: 'read-error', absoluteUri: resolved.absoluteUri, message })
            dependencies.add(resolved.absoluteUri)
          }
          logger.debug('failed to read external markdown {uri}: {message}', {
            uri: resolved.absoluteUri,
            message,
          })
        }
      } else {
        resolutions.set(ref, resolved.resolution)
      }
    }))

    this.updateDependencies(doc, dependencies)
    doc.c4ExternalMarkdown = { refs: resolutions, dependencies }
  }

  private collectRefs(doc: LikeC4LangiumDocument): ast.MarkdownFileRef[] {
    const root = doc.parseResult?.value
    if (!root) {
      return []
    }
    const result: ast.MarkdownFileRef[] = []
    for (const node of AstUtils.streamAst(root)) {
      if (ast.isMarkdownFileRef(node)) {
        result.push(node)
      }
    }
    return result
  }

  private resolveRef(
    ref: ast.MarkdownFileRef,
    doc: LikeC4LangiumDocument,
    project: { folderUri: URI; config: { fileAliases?: Record<string, string> | undefined } },
  ):
    | { kind: 'resolved'; absoluteUri: string }
    | { kind: 'error'; resolution: ExternalMarkdownResolution }
  {
    const raw = ref.path?.trim()
    if (!raw) {
      return { kind: 'error', resolution: { kind: 'empty-path' } }
    }
    if (hasProtocol(raw)) {
      const scheme = raw.slice(0, raw.indexOf(':'))
      return { kind: 'error', resolution: { kind: 'invalid-scheme', scheme } }
    }
    if (raw.startsWith('@')) {
      const resolved = this.resolveAlias(raw, project)
      if (!resolved) {
        const slashIndex = raw.indexOf('/')
        const aliasName = slashIndex > 0 ? raw.slice(0, slashIndex) : raw
        return { kind: 'error', resolution: { kind: 'alias-missing', aliasName } }
      }
      return { kind: 'resolved', absoluteUri: resolved }
    }
    if (hasLeadingSlash(raw)) {
      return { kind: 'resolved', absoluteUri: joinURL(project.folderUri.toString(), raw) }
    }
    if (isRelative(raw) || !raw.includes('://')) {
      return { kind: 'resolved', absoluteUri: joinRelativeURL(doc.uri.toString(), '../', raw) }
    }
    return { kind: 'error', resolution: { kind: 'invalid-scheme', scheme: 'unknown' } }
  }

  private resolveAlias(
    value: string,
    project: { folderUri: URI; config: { fileAliases?: Record<string, string> | undefined } },
  ): string | undefined {
    const slashIndex = value.indexOf('/')
    const aliasName = slashIndex > 0 ? value.slice(0, slashIndex) : value
    const remainingPath = slashIndex > 0 ? value.slice(slashIndex + 1) : ''
    const aliases = project.config.fileAliases ?? {}
    const aliasPath = aliases[aliasName]
    if (!aliasPath) {
      return undefined
    }
    const fullPath = remainingPath ? joinURL(aliasPath, remainingPath) : aliasPath
    return joinURL(project.folderUri.toString(), fullPath)
  }

  private updateDependencies(doc: LikeC4LangiumDocument, next: Set<string>) {
    const docUri = doc.uri.toString()
    const previous = doc.c4ExternalMarkdown?.dependencies ?? new Set<string>()
    for (const mdUri of previous) {
      if (!next.has(mdUri)) {
        const bucket = this.dependents.get(mdUri)
        if (bucket) {
          bucket.delete(docUri)
          if (bucket.size === 0) {
            this.dependents.delete(mdUri)
          }
        }
      }
    }
    for (const mdUri of next) {
      let bucket = this.dependents.get(mdUri)
      if (!bucket) {
        bucket = new Set<string>()
        this.dependents.set(mdUri, bucket)
      }
      bucket.add(docUri)
    }
  }

  forgetDocument(uri: URI): void {
    const docUri = uri.toString()
    for (const [mdUri, bucket] of this.dependents) {
      if (bucket.delete(docUri) && bucket.size === 0) {
        this.dependents.delete(mdUri)
      }
    }
  }

  /** Returns the normalized absolute URI used in the dependency index for comparison. */
  normalizeUri(uri: URI | string): string {
    return UriUtils.normalize(typeof uri === 'string' ? URI.parse(uri) : uri).toString()
  }
}

function isNotFound(error: unknown, message: string): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'EISDIR') return true
  }
  return /ENOENT|not found|no such file/i.test(message)
}

function isNoFilesystem(message: string): boolean {
  return message.includes('No file system is available')
}
