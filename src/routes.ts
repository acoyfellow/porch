const POST_ONLY = new Set(['/send', '/key', '/browser', '/rtc/claim', '/rtc/publish', '/rtc/unpublish', '/focus']);

export function isPostRoute(pathname: string, method: string, route: string): boolean {
  return pathname === route && method === 'POST' && POST_ONLY.has(route);
}
