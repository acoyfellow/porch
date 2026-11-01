import { describe, expect, it } from 'vitest';
import { isPostRoute } from '../src/routes';

describe('isPostRoute', () => {
  it('matches only a POST to the named route', () => {
    expect(isPostRoute('/rtc/publish', 'POST', '/rtc/publish')).toBe(true);
    expect(isPostRoute('/rtc/publish', 'GET', '/rtc/publish')).toBe(false);
    expect(isPostRoute('/send', 'POST', '/rtc/publish')).toBe(false);
    expect(isPostRoute('/focus', 'POST', '/rtc/publish')).toBe(false);
  });

  it('refuses a route that is not on the POST list', () => {
    expect(isPostRoute('/frame', 'POST', '/frame')).toBe(false);
  });
});
