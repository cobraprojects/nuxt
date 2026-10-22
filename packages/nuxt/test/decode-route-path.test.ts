import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { decodeRoutePath } from '../src/core/utils/index.ts'
import { createNormalizedRouteRulesRouter, foldRouteRulePath, foldRouteRulePattern, normalizeRouteRuleKey, normalizeRouteRuleLookupPath, normalizeRouteRulePath } from '../src/core/utils/route-rules.ts'

const RESERVED_RE = /[%;/?:@&=+$,#]/g

const pathSegment = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.constantFrom('a', 'A', 'Ünicode', '测试', 'cafÉ', '100% legit', '%', '%2F', '%25', '%2525', '%C3', '+', ' ', 'a?b', 'a#b'),
)
const routePath = fc.array(pathSegment, { minLength: 1, maxLength: 3 }).map(segments => '/' + segments.join('/'))

describe('decodeRoutePath', () => {
  it('decodes percent-encoded paths', () => {
    expect(decodeRoutePath('/pre/t%65st')).toBe('/pre/test')
    expect(decodeRoutePath('/%E6%B5%8B%E8%AF%95')).toBe('/测试')
  })

  it('decodes double-encoded sequences only once', () => {
    expect(decodeRoutePath('/pre/%2574est')).toBe('/pre/%74est')
  })

  it('leaves reserved characters encoded', () => {
    expect(decodeRoutePath('/pre%2Ftest')).toBe('/pre%2Ftest')
    expect(decodeRoutePath('/pre%3Ftest')).toBe('/pre%3Ftest')
  })

  it('returns unchanged paths that are not percent-encoded or cannot be decoded', () => {
    expect(decodeRoutePath('/pre/test')).toBe('/pre/test')
    expect(decodeRoutePath('/100% legit')).toBe('/100% legit')
    expect(decodeRoutePath('/caf%C3')).toBe('/caf%C3')
  })

  it('decodes only the path portion of a query-bearing path', () => {
    expect(decodeRoutePath('/pre/t%65st?next=%252Fhome')).toBe('/pre/test?next=%252Fhome')
    expect(decodeRoutePath('/pre/test?next=%41')).toBe('/pre/test?next=%41')
  })

  it('should never change the number of path segments', () => {
    fc.assert(fc.property(routePath, (path) => {
      expect(decodeRoutePath(path).split('/').length).toBe(path.split('/').length)
    }), { numRuns: 1000 })
  })

  it('should never introduce a query delimiter', () => {
    fc.assert(fc.property(routePath, (path) => {
      fc.pre(!path.includes('?'))
      expect(decodeRoutePath(path)).not.toContain('?')
    }), { numRuns: 1000 })
  })

  it('should leave every reserved character encoded', () => {
    fc.assert(fc.property(fc.constantFrom(...';/?:@&=+$,#'), (char) => {
      const path = '/x' + encodeURIComponent(char) + 'y'
      expect(decodeRoutePath(path)).toBe(path)
    }))
  })
})

describe('normalizeRouteRulePath', () => {
  it('should fold by lowercasing the unfolded key', () => {
    fc.assert(fc.property(routePath, (path) => {
      expect(normalizeRouteRulePath(path, true)).toBe(normalizeRouteRulePath(path, false).toLowerCase())
    }), { numRuns: 1000 })
  })

  it('should normalize an encoded request path onto its decoded rule key', () => {
    const unreservedSegment = pathSegment.map(segment => segment.replace(RESERVED_RE, ''))
    fc.assert(fc.property(fc.array(unreservedSegment, { minLength: 1, maxLength: 3 }), fc.boolean(), (segments, fold) => {
      const decoded = '/' + segments.join('/')
      const encoded = '/' + segments.map(segment => encodeURIComponent(segment)).join('/')
      expect(normalizeRouteRulePath(encoded, fold)).toBe(normalizeRouteRulePath(decoded, fold))
    }), { numRuns: 1000 })
  })
})

describe('foldRouteRulePath', () => {
  it('lower-cases plain and percent-encoded characters', () => {
    expect(foldRouteRulePath('/Admin/%C3%89cole')).toBe('/admin/%C3%A9cole')
    expect(foldRouteRulePath('/%41dmin')).toBe('/admin')
  })

  it('leaves escapes without a lower-case form as written', () => {
    expect(foldRouteRulePath('/a%2Fb/%e6%b5%8b')).toBe('/a%2Fb/%e6%b5%8b')
    expect(foldRouteRulePath('/%zz/%C3')).toBe('/%zz/%C3')
  })
})

describe('foldRouteRulePattern', () => {
  it('keeps param names and backslash escapes', () => {
    expect(foldRouteRulePattern('GET /Users/:userId/**:Rest')).toBe('get /users/:userId/**:Rest')
    expect(foldRouteRulePattern('/N/:id(\\D+)')).toBe('/n/:id(\\D+)')
  })

  it('folds text inside constraints', () => {
    expect(foldRouteRulePattern('/:id((?:FOO|BAR))/:Rest')).toBe('/:id((?:foo|bar))/:Rest')
  })

  it('folds character escapes of upper-case letters', () => {
    expect(foldRouteRulePattern('/:id(\\x41\\u0042\\103\\u00C9+)')).toBe('/:id(\\x61\\x62\\x63\\xe9+)')
    expect(foldRouteRulePattern('/:id(\\x31\\x61\\u0130\\u{41}\\1)')).toBe('/:id(\\x31\\x61\\u0130\\u{41}\\1)')
  })
})

describe('normalizeRouteRuleKey', () => {
  it('should normalise literal text and only percent-encode regex constraints', () => {
    expect(normalizeRouteRuleKey('/Caf%C3%A9/:slug(caf%C3%A9)/:id(\\D+)', false)).toBe('/Café/:slug(caf%C3%A9)/:id(\\D+)')
    expect(normalizeRouteRuleKey('/Café/:slug(Café|a b)', false)).toBe('/Café/:slug(Caf%C3%A9|a%20b)')
    expect(normalizeRouteRuleKey('/A\\(B\\)/:x([()]+(?:A|B))/C', false)).toBe('/A\\(B\\)/:x([()]+(?:A|B))/C')
  })

  it('should fold regex constraints without folding their escapes', () => {
    expect(normalizeRouteRuleKey('/Caf%C3%A9/:slug(Caf%C3%89)/:id(\\D+)', true)).toBe('/café/:slug(caf%C3%A9)/:id(\\D+)')
    expect(normalizeRouteRuleKey('/A\\(B\\)/:x([()]+(?:A|B))/:y([A-Z]+)', true)).toBe('/a\\(b\\)/:x([()]+(?:a|b))/:y([a-z]+)')
  })

  it('should match lookups against regex constraints', () => {
    for (const fold of [false, true]) {
      const router = createNormalizedRouteRulesRouter([
        { route: '/blog/:slug(caf%C3%A9)', data: { appMiddleware: { auth: true } } },
        { route: '/unencoded/:slug(café)', data: { appMiddleware: { auth: true } } },
        { route: '/x/:id(\\D+)', data: { appMiddleware: { admin: true } } },
        { route: '/upper/:id([A-Z]+)', data: { appMiddleware: { auth: true } } },
        { route: '/escaped/:id(\\x41+)', data: { appMiddleware: { auth: true } } },
      ], '', fold)
      const match = (path: string) => router.matchAll('', normalizeRouteRuleLookupPath(path, fold))
      expect(match('/blog/café'), `fold: ${fold}`).toEqual([{ appMiddleware: { auth: true } }])
      expect(match('/blog/caf%C3%A9'), `fold: ${fold}`).toEqual([{ appMiddleware: { auth: true } }])
      expect(match('/unencoded/café'), `fold: ${fold}`).toEqual([{ appMiddleware: { auth: true } }])
      expect(match('/x/abc'), `fold: ${fold}`).toEqual([{ appMiddleware: { admin: true } }])
      expect(match('/x/123'), `fold: ${fold}`).toEqual([])
      expect(match('/upper/ABC'), `fold: ${fold}`).toEqual([{ appMiddleware: { auth: true } }])
      expect(match('/escaped/AAA'), `fold: ${fold}`).toEqual([{ appMiddleware: { auth: true } }])
    }
    const folded = createNormalizedRouteRulesRouter([
      { route: '/upper/:id([A-Z]+)', data: { appMiddleware: { auth: true } } },
      { route: '/escaped/:id(\\x41+)', data: { appMiddleware: { auth: true } } },
    ], '', true)
    expect(folded.matchAll('', normalizeRouteRuleLookupPath('/Upper/abc', true))).toEqual([{ appMiddleware: { auth: true } }])
    expect(folded.matchAll('', normalizeRouteRuleLookupPath('/Escaped/aaa', true))).toEqual([{ appMiddleware: { auth: true } }])
  })
})
