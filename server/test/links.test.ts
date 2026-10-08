import { describe, expect, it } from 'vitest';
import { isAllowedLink, parseAllowedLinks } from '../src/links.js';

const APP = 'https://ak-sw50-ge-alerter.web.app';
const allowed = parseAllowedLinks('vertexaisearch.cloud.google.com/home/cid/abc/, *.imdigital.com');

describe('notification link allow-list', () => {
  it('parses a comma-separated list and tolerates an https:// prefix', () => {
    expect(parseAllowedLinks(' https://a.example , *.b.example/x/ ,,')).toEqual(['a.example', '*.b.example/x/']);
    expect(parseAllowedLinks(undefined)).toEqual([]);
  });

  it('allows listed hosts, wildcard subdomains, the bare wildcard domain and path prefixes', () => {
    expect(isAllowedLink('https://ge.imdigital.com/run/1', allowed, APP)).toBe(true);
    expect(isAllowedLink('https://a.b.imdigital.com/', allowed, APP)).toBe(true);
    expect(isAllowedLink('https://imdigital.com/', allowed, APP)).toBe(true);
    expect(isAllowedLink('https://vertexaisearch.cloud.google.com/home/cid/abc/r/inbox', allowed, APP)).toBe(true);
    expect(isAllowedLink('https://VERTEXAISEARCH.cloud.google.com/home/cid/abc/', allowed, APP)).toBe(true);
  });

  it('always allows the app itself', () => {
    expect(isAllowedLink(`${APP}/advanced?n=1`, allowed, APP)).toBe(true);
  });

  it('refuses look-alike hosts, other paths, plain http, credentials and junk', () => {
    expect(isAllowedLink('https://imdigital.com.evil.example/', allowed, APP)).toBe(false);
    expect(isAllowedLink('https://evilimdigital.com/', allowed, APP)).toBe(false);
    expect(isAllowedLink('https://vertexaisearch.cloud.google.com/home/cid/zzz/', allowed, APP)).toBe(false);
    expect(isAllowedLink('https://vertexaisearch.cloud.google.com/home/cid/abcdef/', allowed, APP)).toBe(false);
    expect(isAllowedLink('http://ge.imdigital.com/', allowed, APP)).toBe(false);
    expect(isAllowedLink('https://user:pw@ge.imdigital.com/', allowed, APP)).toBe(false);
    expect(isAllowedLink('not a url', allowed, APP)).toBe(false);
  });

  it('allows anything when no list is configured', () => {
    expect(isAllowedLink('https://anything.example/', [], APP)).toBe(true);
  });
});
