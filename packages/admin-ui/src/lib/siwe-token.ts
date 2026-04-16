export function encodeSiweToken(message: string, signature: string): string {
  const json = JSON.stringify({ message, signature });
  const base64 = btoa(unescape(encodeURIComponent(json)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
