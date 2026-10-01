import type { FileSystemNode, URI } from 'langium'
import { describe, it } from 'vitest'
import type { FileNode, FileSystemModuleContext, FileSystemProvider, FileSystemWatcher } from '../../filesystem'
import { NoopFileSystemProvider } from '../../filesystem/noop'
import { createTestServices } from '../../test'

class InMemoryFileSystemProvider extends NoopFileSystemProvider implements FileSystemProvider {
  private readonly files = new Map<string, string>()

  write(uri: string, content: string): void {
    this.files.set(uri, content)
  }

  delete(uri: string): void {
    this.files.delete(uri)
  }

  override readFile(uri: URI): Promise<string> {
    const key = uri.toString()
    const content = this.files.get(key)
    if (content === undefined) {
      const error = new Error(`ENOENT: no such file or directory, open '${uri.fsPath}'`) as Error & { code?: string }
      error.code = 'ENOENT'
      return Promise.reject(error)
    }
    return Promise.resolve(content)
  }

  override readDirectory(): Promise<FileNode[]> {
    return Promise.resolve([])
  }
}

const noopWatcher: FileSystemWatcher = {
  watch: () => {},
  dispose: () => Promise.resolve(),
}

function createFsContext(provider: InMemoryFileSystemProvider): FileSystemModuleContext {
  return {
    fileSystemProvider: () => provider,
    fileSystemWatcher: () => noopWatcher,
  }
}

describe('ExternalMarkdownLoader', () => {
  it('loads relative markdown files into element description', async ({ expect }) => {
    const fs = new InMemoryFileSystemProvider()
    fs.write('file:///test/workspace/src/overview.md', '# Overview\n\nSystem description.')

    const { validate, buildLikeC4Model } = createTestServices({
      context: createFsContext(fs),
    })

    const { errors } = await validate(`
      specification {
        element component
      }
      model {
        c = component 'My Component' {
          description file './overview.md'
        }
      }
    `)

    expect(errors).toEqual([])
    const model = await buildLikeC4Model()
    expect(model.element('c').description.$source).toEqual({ md: '# Overview\n\nSystem description.' })
  })

  it('loads markdown via project-relative absolute path', async ({ expect }) => {
    const fs = new InMemoryFileSystemProvider()
    fs.write('file:///test/workspace/src/docs/system.md', 'System details.')

    const { validate, buildLikeC4Model } = createTestServices({
      context: createFsContext(fs),
      projectConfig: { name: 'abs-path-test' },
    })

    const { errors } = await validate(`
      specification {
        element component
      }
      model {
        c = component {
          description file '/docs/system.md'
        }
      }
    `)

    expect(errors).toEqual([])
    const model = await buildLikeC4Model()
    expect(model.element('c').description.$source).toEqual({ md: 'System details.' })
  })

  it('loads markdown through fileAliases', async ({ expect }) => {
    const fs = new InMemoryFileSystemProvider()
    fs.write('file:///test/workspace/src/content/overview.md', 'Aliased content.')

    const { validate, buildLikeC4Model } = createTestServices({
      context: createFsContext(fs),
      projectConfig: {
        name: 'aliases-test',
        fileAliases: {
          '@docs': './content/',
        },
      },
    })

    const { errors } = await validate(`
      specification {
        element component
      }
      model {
        c = component
      }
      views {
        view v1 of c {
          description file '@docs/overview.md'
        }
      }
    `)

    expect(errors).toEqual([])
    const model = await buildLikeC4Model()
    const view = model.view('v1')
    expect(view.description.$source).toEqual({ md: 'Aliased content.' })
  })

  it('emits a diagnostic when the referenced file is missing', async ({ expect }) => {
    const fs = new InMemoryFileSystemProvider()
    const { validate } = createTestServices({
      context: createFsContext(fs),
    })

    const { errors } = await validate(`
      specification {
        element component
      }
      model {
        c = component {
          description file './missing.md'
        }
      }
    `)

    expect(errors.join('\n')).toMatch(/External markdown file not found/)
  })

  it('emits a diagnostic for unknown file aliases', async ({ expect }) => {
    const fs = new InMemoryFileSystemProvider()
    const { validate } = createTestServices({
      context: createFsContext(fs),
    })

    const { errors } = await validate(`
      specification {
        element component
      }
      model {
        c = component {
          description file '@docs/overview.md'
        }
      }
    `)

    expect(errors.join('\n')).toMatch(/File alias "@docs" is not defined/)
  })

  it('rejects remote URL schemes', async ({ expect }) => {
    const fs = new InMemoryFileSystemProvider()
    const { validate } = createTestServices({
      context: createFsContext(fs),
    })

    const { errors } = await validate(`
      specification {
        element component
      }
      model {
        c = component {
          description file 'https://example.com/x.md'
        }
      }
    `)

    expect(errors.join('\n')).toMatch(/do not support the "https" scheme/)
  })

  it('re-reads markdown when the referenced file changes', async ({ expect }) => {
    const fs = new InMemoryFileSystemProvider()
    const mdUri = 'file:///test/workspace/src/overview.md'
    fs.write(mdUri, 'first')

    const c4Source = `
      specification {
        element component
      }
      model {
        c = component {
          description file './overview.md'
        }
      }
    `
    const c4Uri = 'file:///test/workspace/src/1.c4'
    fs.write(c4Uri, c4Source)

    const { addDocument, services, buildLikeC4Model } = createTestServices({
      context: createFsContext(fs),
    })

    const doc = await addDocument(c4Source)
    await services.shared.workspace.DocumentBuilder.build([doc], { validation: true })
    let model = await buildLikeC4Model()
    expect(model.element('c').description.$source).toEqual({ md: 'first' })

    fs.write(mdUri, 'second')
    await services.shared.workspace.DocumentBuilder.update([doc.uri], [])
    model = await buildLikeC4Model()
    expect(model.element('c').description.$source).toEqual({ md: 'second' })
  })
})

// Keep the referenced import alive for the test file even though it's unused by the TS compiler.
export type _FileSystemNode = FileSystemNode
