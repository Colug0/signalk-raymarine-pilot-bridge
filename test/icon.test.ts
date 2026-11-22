import { describe, expect, it } from 'vitest'
import { lstatSync, readFileSync } from 'node:fs'

// The app store reads signalk.appIcon from the package root. A symlink would
// ship as a text file holding its target on a Windows checkout.
describe('app icon', () => {
  it('is a real SVG file that package.json points to and ships', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(pkg.signalk.appIcon).toBe('./icon.svg')
    expect(pkg.files).toContain('icon.svg')
    expect(lstatSync('icon.svg').isFile()).toBe(true)
    expect(readFileSync('icon.svg', 'utf8')).toContain('<svg')
  })
})
