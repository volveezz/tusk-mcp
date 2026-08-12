import { describe, expect, test } from 'bun:test'
import { formatQueryResult, formatTableDescriptionsResult, formatWriteResult } from './utils.js'

describe('formatQueryResult', () => {
  test('distinguishes null, empty strings, and literal null sentinels', () => {
    const result = formatQueryResult('db', false, {
      columns: ['nil', 'empty', 'sentinel'],
      rows: [{ nil: null, empty: '', sentinel: '\\N' }],
      rowCount: 1,
      truncated: false,
    })

    expect(result.content[0].text).toContain('\\N\t""\t"\\\\N"')
  })

  test('encodes columns as JSON and rows as tab-delimited preview cells', () => {
    const result = formatQueryResult('db', false, {
      columns: ['id', 'payload|json', 'note'],
      rows: [{ id: 1, 'payload|json': { pipe: 'a|b', line: 'a\nb' }, note: 'x\ty' }],
      rowCount: 1,
      truncated: false,
    })

    expect(result.content[0].text).toContain('cols=["id","payload|json","note"]')
    expect(result.content[0].text).toContain('1\t{"pipe":"a|b","line":"a\\nb"}\t"x\\ty"')
  })

  test('prefixes the target line only in multi-target mode', () => {
    const result = { columns: ['id'], rows: [{ id: 1 }], rowCount: 1, truncated: false }

    expect(formatQueryResult('stage', true, result).content[0].text.startsWith('target=stage\n')).toBe(true)
    expect(formatQueryResult('db', false, result).content[0].text.startsWith('target=')).toBe(false)
    expect(formatQueryResult('stage', true, result).structuredContent).toMatchObject({ target: 'stage' })
  })

  test('limits text and structured previews without dropping result metadata', () => {
    const rows = Array.from({ length: 30 }, (_, id) => ({ id }))
    const result = formatQueryResult('db', false, {
      columns: ['id'],
      rows,
      rowCount: rows.length,
      truncated: false,
    })

    expect(result.content[0].text).toContain('preview_rows=25')
    expect(result.structuredContent?.result).toMatchObject({
      rowCount: 30,
      previewRowCount: 25,
      previewTruncated: true,
    })
  })

  test('normalizes non-json-safe scalar values in structured content', () => {
    const result = formatQueryResult('db', false, {
      columns: ['big', 'date', 'nan'],
      rows: [{ big: 10n, date: new Date('2026-05-15T10:00:00.000Z'), nan: Number.NaN }],
      rowCount: 1,
      truncated: false,
    })

    expect(JSON.stringify(result.structuredContent)).toBe(
      '{"target":"db","result":{"columns":["big","date","nan"],"rows":[{"big":"10","date":"2026-05-15T10:00:00.000Z","nan":"NaN"}],"rowCount":1,"previewRowCount":1,"truncated":false,"previewTruncated":false}}',
    )
  })
})

describe('formatWriteResult', () => {
  test('reports command and affected rows, with no returning key when nothing came back', () => {
    const result = formatWriteResult('local', false, { command: 'UPDATE', affectedRows: 3 })

    expect(result.content[0].text).toBe('UPDATE affected=3')
    expect(result.structuredContent).toEqual({ target: 'local', command: 'UPDATE', affectedRows: 3 })
  })

  test('previews RETURNING rows under the affected-row header', () => {
    const result = formatWriteResult('local', true, {
      command: 'INSERT',
      affectedRows: 2,
      returning: {
        columns: ['id'],
        rows: [{ id: 1 }, { id: 2 }],
        rowCount: 2,
        truncated: false,
      },
    })

    expect(result.content[0].text.startsWith('target=local\nINSERT affected=2\nrows=2 cols=1')).toBe(true)
    expect(result.structuredContent?.returning).toMatchObject({ rowCount: 2, previewRowCount: 2 })
  })
})

describe('formatTableDescriptionsResult', () => {
  test('renders multiple tables, multiple foreign keys on one column, and missing tables', () => {
    const result = formatTableDescriptionsResult('stage', true, [
      {
        schema: 'public',
        table: 'edges',
        columns: [{
          name: 'node_id',
          type: 'uuid',
          nullable: false,
          defaultValue: null,
          isPrimaryKey: false,
        }],
        foreignKeys: [
          {
            columnName: 'node_id',
            referencedTable: 'public.nodes',
            referencedColumn: 'id',
            constraintName: 'edges_node_id_fkey',
          },
          {
            columnName: 'node_id',
            referencedTable: 'archive.nodes',
            referencedColumn: 'id',
            constraintName: 'edges_node_id_archive_fkey',
          },
        ],
      },
      { schema: 'public', table: 'ghost', columns: [], foreignKeys: [] },
    ])

    const text = result.content[0].text
    expect(text.startsWith('target=stage\npublic.edges')).toBe(true)
    expect(text).toContain('-> public.nodes.id(edges_node_id_fkey)')
    expect(text).toContain('-> archive.nodes.id(edges_node_id_archive_fkey)')
    expect(text).toContain('public.ghost: not found')
  })
})
