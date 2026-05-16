import { describe, expect, test } from 'bun:test'
import { formatQueryResult, formatTableDescriptionResult } from './utils.js'

describe('formatQueryResult', () => {
  test('distinguishes null, empty strings, and literal null sentinels', () => {
    const result = formatQueryResult({
      columns: ['nil', 'empty', 'sentinel'],
      rows: [{ nil: null, empty: '', sentinel: '\\N' }],
      rowCount: 1,
      truncated: false,
    })

    expect(result.content[0].text).toContain('\\N\t""\t"\\\\N"')
  })

  test('encodes columns as JSON and rows as tab-delimited preview cells', () => {
    const result = formatQueryResult({
      columns: ['id', 'payload|json', 'note'],
      rows: [{ id: 1, 'payload|json': { pipe: 'a|b', line: 'a\nb' }, note: 'x\ty' }],
      rowCount: 1,
      truncated: false,
    })

    expect(result.content[0].text).toContain('cols=["id","payload|json","note"]')
    expect(result.content[0].text).toContain('1\t{"pipe":"a|b","line":"a\\nb"}\t"x\\ty"')
  })

  test('limits text and structured previews without dropping result metadata', () => {
    const rows = Array.from({ length: 30 }, (_, id) => ({ id }))
    const result = formatQueryResult({
      columns: ['id'],
      rows,
      rowCount: rows.length,
      truncated: false,
    })

    expect(result.content[0].text).toContain('preview_rows=25')
    expect(result.structuredContent?.result).toMatchObject({
      rowCount: 30,
      returnedRowCount: 30,
      previewRowCount: 25,
      previewTruncated: true,
    })
  })

  test('normalizes non-json-safe scalar values in structured content', () => {
    const result = formatQueryResult({
      columns: ['big', 'date', 'nan'],
      rows: [{ big: 10n, date: new Date('2026-05-15T10:00:00.000Z'), nan: Number.NaN }],
      rowCount: 1,
      truncated: false,
    })

    expect(JSON.stringify(result.structuredContent)).toBe(
      '{"result":{"columns":["big","date","nan"],"rows":[{"big":"10","date":"2026-05-15T10:00:00.000Z","nan":"NaN"}],"rowCount":1,"returnedRowCount":1,"previewRowCount":1,"truncated":false,"previewTruncated":false}}',
    )
  })
})

describe('formatTableDescriptionResult', () => {
  test('renders multiple foreign keys on one column', () => {
    const result = formatTableDescriptionResult({
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
    })

    expect(result.content[0].text).toContain('-> public.nodes.id(edges_node_id_fkey)')
    expect(result.content[0].text).toContain('-> archive.nodes.id(edges_node_id_archive_fkey)')
  })
})
