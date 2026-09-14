/**
 * Resolve names at an external Salesforce boundary, not inside Apex or metadata.
 * Each connection must construct its own resolver from its configured prefix.
 * This performs syntax validation only, never schema, permissions or tenant checks.
 */
export interface SalesforceNames {
  readonly namespacePrefix: string;
  /** Unqualified Kusanya-owned custom object, including its __c suffix. */
  readonly kusanyaObject: (localName: string) => string;
  /** Unqualified Kusanya-owned custom field, including its __c suffix. */
  readonly kusanyaField: (localName: string) => string;
  /** Single unqualified Kusanya-owned parent or child relationship, ending __r. */
  readonly kusanyaRelationship: (localName: string) => string;
  /** Exact target API name from a mapping/describe; never automatically prefixed. */
  readonly targetObject: (apiName: string) => string;
  /** Exact target API name from a mapping/describe; never automatically prefixed. */
  readonly targetField: (apiName: string) => string;
  /** Exact single relationship API name from describe; never a traversal path. */
  readonly targetRelationship: (apiName: string) => string;
  /** Literal relative Kusanya REST resource; excludes host, query and wildcards. */
  readonly apexRestPath: (relativeResource: string) => string;
}

export class SalesforceNameError extends Error {
  constructor(part: string) {
    super(`Invalid Salesforce ${part}`);
    this.name = 'SalesforceNameError';
  }
}

// No consecutive or trailing underscores in a local component name. The __c
// suffix is supplied by the caller; a qualified name fails instead of doubling it.
const localCustomName = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*__c$/;
// Relationship names are explicit: do not infer a child name from a field name,
// or broaden object/field validation to accept relationship and other suffixes.
const localCustomRelationship = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*__r$/;
// A single API identifier only: not SOQL, a field traversal, an XPath or a URL.
// Preserve standard, customer custom and foreign-namespaced names byte for byte.
const targetApiName = /^[A-Za-z][A-Za-z0-9]*(?:_{1,2}[A-Za-z0-9]+)*$/;

export function createSalesforceNames(
  namespacePrefix: string,
): SalesforceNames {
  if (typeof namespacePrefix !== 'string')
    throw new SalesforceNameError('namespace prefix');
  const namespace = namespacePrefix.slice(0, -2);
  if (
    namespacePrefix !== '' &&
    (!namespacePrefix.endsWith('__') ||
      namespace.length > 15 ||
      namespace !== namespace.trim() ||
      !/^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/.test(namespace))
  )
    throw new SalesforceNameError('namespace prefix');

  function ownedName(
    localName: string,
    part: string,
    shape: RegExp = localCustomName,
  ): string {
    if (
      typeof localName !== 'string' ||
      localName !== localName.trim() ||
      !shape.test(localName)
    )
      throw new SalesforceNameError(part);
    return `${namespacePrefix}${localName}`;
  }

  function targetName(apiName: string, part: string): string {
    if (
      typeof apiName !== 'string' ||
      apiName !== apiName.trim() ||
      !targetApiName.test(apiName)
    )
      throw new SalesforceNameError(part);
    return apiName;
  }

  return Object.freeze({
    namespacePrefix,
    kusanyaObject: (localName: string) =>
      ownedName(localName, 'owned object name'),
    kusanyaField: (localName: string) =>
      ownedName(localName, 'owned field name'),
    kusanyaRelationship: (localName: string) =>
      ownedName(localName, 'owned relationship name', localCustomRelationship),
    targetObject: (apiName: string) =>
      targetName(apiName, 'target object name'),
    targetField: (apiName: string) => targetName(apiName, 'target field name'),
    targetRelationship: (apiName: string) =>
      targetName(apiName, 'target relationship name'),
    apexRestPath: (relativeResource: string): string => {
      if (
        typeof relativeResource !== 'string' ||
        relativeResource !== relativeResource.trim() ||
        !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(relativeResource)
      )
        throw new SalesforceNameError('REST resource');
      // Apex REST uses the namespace as a path segment, without the API-name __.
      const base = namespacePrefix === '' ? '' : `${namespace}/`;
      return `/services/apexrest/${base}${relativeResource}`;
    },
  });
}
