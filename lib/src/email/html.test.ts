import { describe, expect, it } from 'vitest';

import { brandEmailHtml } from './html';

describe('brandEmailHtml', () => {
  it('escapes markup so a facility name cannot inject HTML', () => {
    const html = brandEmailHtml('Игрище <script>alert(1)</script> & парк');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; парк');
  });

  it('turns bare URLs into links and keeps the visible URL text', () => {
    const html = brandEmailHtml('Виж: https://pops.bg/sesiya/abc');
    expect(html).toContain('<a href="https://pops.bg/sesiya/abc"');
    expect(html).toContain('>https://pops.bg/sesiya/abc</a>');
  });

  it('splits blank-line blocks into paragraphs and single breaks into <br>', () => {
    const html = brandEmailHtml('ред едно\nред две\n\nвтори абзац');
    expect(html).toContain('ред едно<br>ред две');
    expect((html.match(/<p /g) ?? []).length).toBe(2);
  });

  it('carries the brand chrome (coral rule, paper background)', () => {
    const html = brandEmailHtml('тест');
    expect(html).toContain('#FF4A2B');
    expect(html).toContain('#F5F3EE');
  });
});
