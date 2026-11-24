import { expect, test } from 'bun:test'
import pkg from '../package.json'
import server from '../server.json'

test('server.json names the npm release it was published with', () => {
  expect(server.name).toBe(pkg.mcpName)
  expect(server.version).toBe(pkg.version)
  expect(server.packages[0]).toMatchObject({ identifier: pkg.name, version: pkg.version })
})
