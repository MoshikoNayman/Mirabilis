import { describe, it, expect } from 'vitest';
import { isLocalImageSrc, remoteImageLink } from './markdownMedia.js';

const ORIGINS = ['http://localhost:3000', 'http://192.168.1.20:4000'];

describe('isLocalImageSrc', () => {
  it('loads inline, blob, same-origin and loopback images', () => {
    expect(isLocalImageSrc('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isLocalImageSrc('blob:http://localhost:3000/5b1c')).toBe(true);
    expect(isLocalImageSrc('/api/images/a.png')).toBe(true);
    expect(isLocalImageSrc('images/a.png')).toBe(true);
    expect(isLocalImageSrc('http://localhost:4000/api/images/a.png')).toBe(true);
    expect(isLocalImageSrc('http://127.0.0.1:8080/x.png')).toBe(true);
    expect(isLocalImageSrc('http://[::1]:4000/x.png')).toBe(true);
  });

  it('treats the backend origin as local, even on the LAN', () => {
    expect(isLocalImageSrc('http://192.168.1.20:4000/api/images/a.png', ORIGINS)).toBe(true);
    expect(isLocalImageSrc('http://192.168.1.20:9999/a.png', ORIGINS)).toBe(false);
  });

  it('never auto-loads a remote image, the exfiltration path', () => {
    expect(isLocalImageSrc('https://evil.example/p.png?q=secret', ORIGINS)).toBe(false);
    expect(isLocalImageSrc('//evil.example/p.png', ORIGINS)).toBe(false);
    expect(isLocalImageSrc('\\\\evil.example\\p.png', ORIGINS)).toBe(false);
    expect(isLocalImageSrc('http://localhost.evil.example/p.png', ORIGINS)).toBe(false);
    expect(isLocalImageSrc('ftp://evil.example/p.png', ORIGINS)).toBe(false);
    expect(isLocalImageSrc('javascript:alert(1)', ORIGINS)).toBe(false);
    expect(isLocalImageSrc('', ORIGINS)).toBe(false);
    expect(isLocalImageSrc(undefined, ORIGINS)).toBe(false);
  });
});

describe('remoteImageLink', () => {
  it('labels the link with the alt text and the host', () => {
    expect(remoteImageLink('https://cdn.example/a.png', 'Chart')).toEqual({ href: 'https://cdn.example/a.png', label: 'Chart (cdn.example)' });
    expect(remoteImageLink('https://cdn.example/a.png', '')).toEqual({ href: 'https://cdn.example/a.png', label: 'Image (cdn.example)' });
  });

  it('drops a non-web href', () => {
    expect(remoteImageLink('javascript:alert(1)', 'x')).toEqual({ href: null, label: 'x' });
    expect(remoteImageLink(undefined, undefined)).toEqual({ href: null, label: 'Image' });
  });
});
