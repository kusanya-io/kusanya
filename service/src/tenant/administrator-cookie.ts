/** One shared browser-session cookie contract for the server and HTTP clients. */
const cookieName = '__Host-kusanya_admin_session';
const sessionPattern = /^[A-Za-z0-9_-]{43}$/;
const minimumSessionAgeSeconds = 60;
const maximumSessionAgeSeconds = 86_400;

export const administratorSessionCookieName = cookieName;

export class AdministratorSessionCookieError extends Error {
  constructor() {
    super('ADMINISTRATOR_SESSION_COOKIE');
    this.name = 'AdministratorSessionCookieError';
  }
}

function fail(): never {
  throw new AdministratorSessionCookieError();
}

export function isAdministratorSessionValue(value: unknown): value is string {
  return typeof value === 'string' && sessionPattern.test(value);
}

/** Read one valid administrator session from a Cookie header, never duplicates. */
export function readAdministratorSessionCookie(
  header: unknown,
): string | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string') fail();
  const matches: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) fail();
    if (part.slice(0, separator).trim() === cookieName)
      matches.push(part.slice(separator + 1).trim());
  }
  if (matches.length > 1) fail();
  const opaqueSession = matches[0];
  if (
    opaqueSession !== undefined &&
    !isAdministratorSessionValue(opaqueSession)
  )
    fail();
  return opaqueSession;
}

/** Emit the sole canonical Set-Cookie form; an empty value is only for clearing. */
export function serializeAdministratorSessionCookie(
  value: string,
  maxAgeSeconds: number,
): string {
  if (
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 0 ||
    maxAgeSeconds > maximumSessionAgeSeconds ||
    (value === ''
      ? maxAgeSeconds !== 0
      : !isAdministratorSessionValue(value) ||
        maxAgeSeconds < minimumSessionAgeSeconds)
  )
    fail();
  return `${cookieName}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

export interface ParsedAdministratorSessionCookie {
  readonly opaqueSession: string;
  readonly maxAgeSeconds: number;
}

/** Accept the exact security attributes without coupling clients to their order. */
export function parseAdministratorSessionSetCookie(
  value: unknown,
): ParsedAdministratorSessionCookie {
  if (typeof value !== 'string') fail();
  const parts = value.split('; ');
  if (parts.length !== 6) fail();
  const prefix = `${cookieName}=`;
  if (!parts[0]!.startsWith(prefix)) fail();
  const opaqueSession = parts[0]!.slice(prefix.length);
  if (!isAdministratorSessionValue(opaqueSession)) fail();
  const attributes = new Set(parts.slice(1));
  if (attributes.size !== 5) fail();
  const maxAgeAttributes = [...attributes].filter((part) =>
    part.startsWith('Max-Age='),
  );
  if (maxAgeAttributes.length !== 1) fail();
  const maxAgeText = maxAgeAttributes[0]!.slice('Max-Age='.length);
  if (!/^[0-9]{1,5}$/.test(maxAgeText)) fail();
  const maxAgeSeconds = Number(maxAgeText);
  if (
    maxAgeSeconds < minimumSessionAgeSeconds ||
    maxAgeSeconds > maximumSessionAgeSeconds ||
    !attributes.has('Path=/') ||
    !attributes.has('Secure') ||
    !attributes.has('HttpOnly') ||
    !attributes.has('SameSite=Lax')
  )
    fail();
  return Object.freeze({ opaqueSession, maxAgeSeconds });
}
