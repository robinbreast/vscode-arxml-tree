import * as vscode from 'vscode';
import { ArxmlNode } from './arxmlNode';
import { CustomViewConfig } from './customViewStore';
import { DiagnosticServiceSummary, TreeItemPresentation, ViewBehavior } from './viewBehavior';

const UDS_NRC_LABELS: Record<string, string> = {
  '10': 'generalReject',
  '11': 'serviceNotSupported',
  '12': 'subFunctionNotSupported',
  '13': 'incorrectMessageLengthOrInvalidFormat',
  '14': 'responseTooLong',
  '21': 'busyRepeatRequest',
  '22': 'conditionsNotCorrect',
  '24': 'requestSequenceError',
  '25': 'noResponseFromSubnetComponent',
  '26': 'failurePreventsExecution',
  '31': 'requestOutOfRange',
  '33': 'securityAccessDenied',
  '35': 'invalidKey',
  '36': 'exceedNumberOfAttempts',
  '37': 'requiredTimeDelayNotExpired',
  '78': 'responsePending'
};

const CDD_ELEMENT_LABELS: Record<string, string> = {
  ECUDOC: 'ECU Document',
  EXTSTORAGEITEMS: 'External Storage',
  EXTSTORAGEITEM: 'External Asset',
  ATTRCATS: 'Attribute Categories',
  ATTRCAT: 'Attribute Category',
  DEFATTS: 'Definitions',
  DATAOBJATTS: 'Data Objects',
  DATATYPEATTS: 'Data Types',
  STRDEF: 'String Definition',
  CSTRDEF: 'Const String Definition',
  ENUMDEF: 'Enumeration Definition',
  UNSDEF: 'Unsigned Definition',
  DIAGCLASSATTS: 'Diagnostic Classes',
  DIAGINSTATTS: 'Diagnostic Instances',
  DIAGCLASS: 'Diagnostic Class',
  DIAGINST: 'Diagnostic Instance',
  SERVICE: 'Service',
  SIMPLECOMPCONT: 'Container',
  DATAOBJ: 'Data Object',
  SPECDATAOBJ: 'Special Data Object',
  NEGRESCODEPROXIES: 'Negative Responses',
  NEGRESCODEPROXY: 'Negative Response',
  ECUATTS: 'ECU Attributes'
};

const CDD_RICH_DESCRIPTION_ELEMENTS = new Set([
  'DIAGCLASS',
  'DIAGINST',
  'SERVICE',
  'DATAOBJ',
  'SPECDATAOBJ',
  'NEGRESCODEPROXY'
]);

export function isCddView(view?: CustomViewConfig): boolean {
  return Boolean(view && (view.id.startsWith('builtin-cdd-') || view.name.toUpperCase().includes('CDD')));
}

export function buildTreePresentation(node: ArxmlNode, view?: CustomViewConfig): TreeItemPresentation | undefined {
  if (!isCddView(view)) {
    return undefined;
  }

  const alias = CDD_ELEMENT_LABELS[node.element];
  const label = alias && node.name === node.element ? alias : node.name;
  const description = buildRichDescription(node) ?? (alias && alias !== node.element ? `${node.element} (${alias})` : node.element);
  const collapsibleState = node.children.length === 0
    ? vscode.TreeItemCollapsibleState.None
    : (node.element === 'ECUDOC' || node.element === 'DEFATTS' || node.element === 'DIAGCLASSATTS'
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed);

  const tooltipLines = [
    `ELEMENT: ${node.element}`,
    alias ? `Category: ${alias}` : undefined,
    `ARPATH: ${node.arpath}`,
    `UUID: ${node.uuid}`,
    `Children: ${node.children.length}`,
    `File: ${node.file.fsPath}`,
    `Line: ${node.range.start.line + 1} ~ ${node.range.end.line + 1}`
  ].filter((line): line is string => Boolean(line));

  if (CDD_RICH_DESCRIPTION_ELEMENTS.has(node.element)) {
    const attrs = readNodeAttributes(node);
    if (node.element === 'SERVICE') {
      const semantic = readNodeTagText(node, 'SEMANTIC');
      const shortcut = readNodeTagText(node, 'SHORTCUTQUAL');
      if (semantic) {
        tooltipLines.splice(2, 0, `Semantic: ${semantic}`);
      }
      if (shortcut) {
        tooltipLines.splice(3, 0, `Shortcut: ${shortcut}`);
      }
      if (attrs.req || attrs.func || attrs.phys) {
        tooltipLines.splice(4, 0, `Flags: req=${attrs.req ?? '-'}, func=${attrs.func ?? '-'}, phys=${attrs.phys ?? '-'}`);
      }
    }
    if ((node.element === 'DATAOBJ' || node.element === 'SPECDATAOBJ') && attrs.dtref) {
      tooltipLines.splice(2, 0, `Data Type Ref: ${attrs.dtref}`);
      if (attrs.v) {
        tooltipLines.splice(3, 0, `Default Value: ${attrs.v}`);
      }
    }
    if (node.element === 'DIAGINST' || node.element === 'DIAGCLASS') {
      const services = node.children.filter(child => child.element === 'SERVICE').length;
      const dataObjects = node.children.filter(child => child.element === 'DATAOBJ' || child.element === 'SPECDATAOBJ').length;
      tooltipLines.splice(2, 0, `Services: ${services}, Data Objects: ${dataObjects}`);
    }
  }

  return {
    label,
    description,
    collapsibleState,
    tooltip: tooltipLines.join('\n')
  };
}

export function collectServiceSummaries(root: ArxmlNode): DiagnosticServiceSummary[] {
  const doc = getDocumentForNode(root);
  if (!doc) {
    return [];
  }
  const nrcMap = buildNegativeResponseCodeMap(doc);

  const result: DiagnosticServiceSummary[] = [];
  const classes = collectNodes(root, node => node.element === 'DIAGCLASS');
  for (const diagClass of classes) {
    const diagInstances = diagClass.children.filter(node => node.element === 'DIAGINST');
    for (const diagInst of diagInstances) {
      const services = diagInst.children.filter(node => node.element === 'SERVICE');
      for (let index = 0; index < services.length; index += 1) {
        const service = services[index];
        const section = getServiceSection(doc, diagInst, services, index);
        const attrs = readNodeAttributes(service);
        const semantic = readNodeTagText(service, 'SEMANTIC') ?? '-';
        const qual = readNodeTagText(service, 'QUAL') ?? '';
        const shortcut = readNodeTagText(service, 'SHORTCUTQUAL') ?? '';
        const sid = extractServiceId(service, section.text) ?? '-';
        const serviceType = resolveServiceTypeLabel(sid, semantic, service.name);
        const subFunction = extractSubFunction(section.text) ?? '-';
        const identifier = extractPrimaryIdentifier(sid, section.text, qual, shortcut, service.name);
        const identifierKind = resolveIdentifierKind(sid, identifier.source);
        const identifierValue = identifier.value ?? '-';
        const did = identifierKind === 'DID' ? identifierValue : '-';
        const profile = analyzePayloadProfile(section.text);
        const dataLength = buildLengthSummary(sid, identifierValue, profile);
        const responses = extractResponseSummary(section.text, sid, identifierValue, profile, nrcMap);
        const udsRequest = buildUdsRequestSummary(sid, identifierValue, subFunction, profile, attrs);
        result.push({
          diagClass: diagClass.name,
          diagInstance: diagInst.name,
          serviceName: service.name,
          semantic,
          sid,
          did,
          serviceType,
          identifierKind,
          identifier: identifierValue,
          subFunction,
          dataLength,
          request: udsRequest,
          responses,
          file: service.file.fsPath,
          line: service.range.start.line + 1,
          column: service.range.start.character + 1,
          arpath: service.arpath
        });
      }
    }
  }

  return result.sort((left, right) => {
    if (left.diagClass !== right.diagClass) {
      return left.diagClass.localeCompare(right.diagClass);
    }
    if (left.diagInstance !== right.diagInstance) {
      return left.diagInstance.localeCompare(right.diagInstance);
    }
    return left.serviceName.localeCompare(right.serviceName);
  });
}

export function createCddViewBehavior(): ViewBehavior {
  return {
    id: 'cdd-behavior',
    matches: isCddView,
    presentNode: (node: ArxmlNode, view?: CustomViewConfig) => buildTreePresentation(node, view),
    collectServiceSummaries
  };
}

function buildRichDescription(node: ArxmlNode): string | undefined {
  const attrs = readNodeAttributes(node);
  if (node.element === 'SERVICE') {
    const semantic = readNodeTagText(node, 'SEMANTIC');
    const parts = [semantic ? `semantic=${semantic}` : undefined, attrs.req ? `req=${attrs.req}` : undefined]
      .filter((value): value is string => Boolean(value));
    return parts.join(' | ') || 'SERVICE';
  }
  if (node.element === 'DATAOBJ' || node.element === 'SPECDATAOBJ') {
    const parts = [attrs.dtref ? `dtref=${attrs.dtref}` : undefined, attrs.v ? `v=${attrs.v}` : undefined]
      .filter((value): value is string => Boolean(value));
    return parts.join(' | ') || node.element;
  }
  if (node.element === 'DIAGINST' || node.element === 'DIAGCLASS') {
    const serviceCount = node.children.filter(child => child.element === 'SERVICE').length;
    return `services=${serviceCount}`;
  }
  return undefined;
}

function collectNodes(root: ArxmlNode, predicate: (node: ArxmlNode) => boolean): ArxmlNode[] {
  const stack: ArxmlNode[] = [root];
  const nodes: ArxmlNode[] = [];
  while (stack.length) {
    const current = stack.pop()!;
    if (predicate(current)) {
      nodes.push(current);
    }
    stack.push(...current.children);
  }
  return nodes;
}

function getDocumentForNode(node: ArxmlNode): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(document => document.uri.toString() === node.file.toString());
}

function getServiceSection(doc: vscode.TextDocument, diagInst: ArxmlNode, services: ArxmlNode[], index: number): { text: string } {
  const service = services[index];
  const nextService = index + 1 < services.length ? services[index + 1] : undefined;
  const startLine = service.range.start.line;
  const endLine = Math.min(
    nextService ? Math.max(startLine, nextService.range.start.line - 1) : diagInst.range.end.line,
    doc.lineCount - 1
  );
  const text = doc.getText(new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length));
  return { text };
}

function analyzePayloadProfile(sectionText: string): { reqObjects: number; respObjects: number; totalObjects: number } {
  const sidRqIndex = sectionText.indexOf('<QUAL>SID_RQ</QUAL>');
  const sidPrIndex = sectionText.indexOf('<QUAL>SID_PR</QUAL>');
  const dataObjMatches = [...sectionText.matchAll(/<(DATAOBJ|SPECDATAOBJ|STRUCT)\b/gi)];
  const totalObjects = dataObjMatches.length;

  let reqCount = 0;
  let respCount = 0;
  if (sidPrIndex > -1) {
    for (const match of dataObjMatches) {
      const at = match.index ?? 0;
      if (sidRqIndex > -1 && at < sidRqIndex) {
        continue;
      }
      if (at < sidPrIndex) {
        reqCount += 1;
      } else {
        respCount += 1;
      }
    }
  } else {
    reqCount = totalObjects;
  }

  return {
    reqObjects: reqCount,
    respObjects: respCount,
    totalObjects
  };
}

function buildLengthSummary(sid: string, did: string, profile: { reqObjects: number; respObjects: number; totalObjects: number }): string {
  const sidBytes = sid && sid !== '-' ? 1 : 0;
  const didBytes = did && did !== '-' ? 2 : 0;
  const reqBase = sidBytes + didBytes;
  if (profile.totalObjects === 0) {
    return reqBase > 0 ? `req>=${reqBase}B` : '-';
  }
  if (didBytes > 0 && profile.reqObjects <= 1 && profile.respObjects <= 1) {
    const respBase = sidBytes + didBytes;
    return `DID frame: req>=${reqBase}B, resp>=${respBase}B`;
  }
  if (profile.respObjects > 0) {
    const respBase = sidBytes + didBytes;
    return `req>=${reqBase}B + ${profile.reqObjects}obj, resp>=${respBase}B + ${profile.respObjects}obj`;
  }
  return `req>=${reqBase}B + ${profile.reqObjects}obj`;
}

function extractResponseSummary(
  sectionText: string,
  sid: string,
  did: string,
  profile: { reqObjects: number; respObjects: number; totalObjects: number },
  nrcMap: Map<string, string>
): string {
  const negatives = [...sectionText.matchAll(/<NEGRESCODEPROXY\b[^>]*idref=['"]([^'"]+)['"]/gi)].map(match => match[1]);
  const unique = Array.from(new Set(negatives));
  const resolved = unique
    .map(id => nrcMap.get(id))
    .filter((value): value is string => Boolean(value));
  const nrc = resolved.length > 0 ? resolved.join(',') : `count=${unique.length}`;
  const nrcLabeled = resolved.length > 0 ? resolved.map(value => {
    const code = (toHexByte(value) ?? value.replace(/^0x/i, '').toUpperCase()).padStart(2, '0');
    const label = UDS_NRC_LABELS[code];
    return label ? `0x${code}(${label})` : `0x${code}`;
  }) : [];
  const positive = sectionText.includes('<QUAL>SID_PR</QUAL>') ? 'yes' : 'unknown';
  const positiveSid = extractPositiveSidFromSection(sectionText) ?? (positive === 'yes' ? computePositiveSid(sid) : undefined);
  const posBytes = buildPositiveFrame(positiveSid, did, profile.respObjects);
  const negBytes = buildNegativeFrame(sid, resolved.length > 0 ? resolved : undefined);
  if (posBytes || negBytes) {
    const nrcPart = nrcLabeled.length > 0 ? `NRC: ${nrcLabeled.join('|')}` : (nrc !== 'count=0' ? `NRC: ${nrc}` : undefined);
    return [posBytes ? `POS: ${posBytes}` : undefined, negBytes ? `NEG: ${negBytes}` : undefined, nrcPart]
      .filter((value): value is string => Boolean(value))
      .join(' | ');
  }
  return positiveSid ? `pos=${positiveSid}; nrc=${nrc}` : `pos=${positive}; nrc=${nrc}`;
}

function buildUdsRequestSummary(
  sid: string,
  identifier: string,
  subFunction: string,
  profile: { reqObjects: number; respObjects: number; totalObjects: number },
  attrs: Record<string, string>
): string {
  const bytes = extractRequestFrameFromSection(sid, identifier, subFunction, profile.reqObjects);
  const flags = `req=${attrs.req ?? '-'},func=${attrs.func ?? '-'},phys=${attrs.phys ?? '-'}`;
  return [bytes ? `RQ: ${bytes}` : 'RQ: ?', flags].filter((part): part is string => Boolean(part)).join(' | ');
}

function extractRequestFrameFromSection(sid: string, identifier: string, subFunction: string, objectCount: number): string | undefined {
  return buildRequestFrame(sid, identifier, subFunction, objectCount);
}

function buildRequestFrame(sid: string, identifier: string, subFunction: string, objectCount: number): string | undefined {
  const sidByte = toHexByte(sid);
  if (!sidByte) {
    return undefined;
  }
  const parts = [sidByte];
  if (subFunction && subFunction !== '-') {
    const sf = toHexByte(subFunction);
    if (sf) {
      parts.push(sf);
    }
  }
  if (identifier && identifier !== '-' && /^0x[0-9A-Fa-f]{4}$/i.test(identifier)) {
    parts.push(identifier.slice(2, 4).toUpperCase(), identifier.slice(4, 6).toUpperCase());
  }
  if (objectCount > 0) {
    parts.push(`[..${objectCount}obj]`);
  }
  return parts.join(' ');
}

function buildPositiveFrame(positiveSid: string | undefined, identifier: string, objectCount: number): string | undefined {
  const sidByte = toHexByte(positiveSid);
  if (!sidByte) {
    return undefined;
  }
  const parts = [sidByte];
  if (identifier && identifier !== '-' && /^0x[0-9A-Fa-f]{4}$/i.test(identifier)) {
    parts.push(identifier.slice(2, 4).toUpperCase(), identifier.slice(4, 6).toUpperCase());
  }
  if (objectCount > 0) {
    parts.push(`[..${objectCount}obj]`);
  }
  return parts.join(' ');
}

function extractPositiveSidFromSection(sectionText: string): string | undefined {
  const direct = extractByteByQualifier(sectionText, /SID_PR/i);
  return direct ? `0x${direct}` : undefined;
}

function buildNegativeFrame(sid: string, nrcs?: string[]): string | undefined {
  const sidByte = toHexByte(sid);
  if (!sidByte) {
    return undefined;
  }
  if (!nrcs || nrcs.length === 0) {
    return `7F ${sidByte} [NRC]`;
  }
  const compact = nrcs.slice(0, 6).map(value => toHexByte(value) ?? value.replace(/^0x/i, '').toUpperCase());
  const suffix = nrcs.length > compact.length ? ` ...(+${nrcs.length - compact.length})` : '';
  return `7F ${sidByte} ${compact.join('|')}${suffix}`;
}

function toHexByte(value?: string): string | undefined {
  if (!value || value === '-') {
    return undefined;
  }
  const normalized = value.trim();
  if (/^0x[0-9A-Fa-f]+$/i.test(normalized)) {
    const parsed = Number.parseInt(normalized.slice(2), 16);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }
    return parsed.toString(16).toUpperCase().padStart(2, '0');
  }
  if (/^[0-9]+$/.test(normalized)) {
    const parsed = Number.parseInt(normalized, 10);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }
    return parsed.toString(16).toUpperCase().padStart(2, '0');
  }
  return undefined;
}

function extractDidFromQualifiedBytes(sectionText: string): string | undefined {
  const hi = extractByteByQualifier(sectionText, /DID[_-]?HI|Identifier[_-]?Hi|RecordIdentifier[_-]?Hi/i);
  const lo = extractByteByQualifier(sectionText, /DID[_-]?LO|Identifier[_-]?Lo|RecordIdentifier[_-]?Lo/i);
  if (!hi || !lo) {
    return undefined;
  }
  return `0x${hi}${lo}`;
}

function extractSubFunction(sectionText: string): string | undefined {
  return extractByteByQualifier(sectionText, /SUBFUNCTION|RoutineControlType|ControlType|ControlOptionRecord/i)
    ?? extractByteByQualifier(sectionText, /SessionType|ResetType|AccessType/i);
}

function extractPrimaryIdentifier(
  sid: string,
  sectionText: string,
  qual: string,
  shortcut: string,
  serviceName: string
): { value?: string; source: 'did' | 'rid' | 'other' } {
  const normalizedSid = sid.toUpperCase();
  if (normalizedSid === '0X31' || /Routine/i.test(serviceName) || /RoutineIdentifier/i.test(sectionText)) {
    const rid = extractBytePairByQualifier(sectionText, /RoutineIdentifier|RID/i);
    if (rid) {
      return { value: rid, source: 'rid' };
    }
  }

  const didByQual = extractDidFromQualifiedBytes(sectionText);
  if (didByQual) {
    return { value: didByQual, source: 'did' };
  }

  const did = extractDid(sectionText, qual, shortcut, serviceName);
  if (did) {
    return { value: did, source: 'did' };
  }

  return { source: 'other' };
}

function extractBytePairByQualifier(sectionText: string, qualifierRegex: RegExp): string | undefined {
  const hi = extractByteByQualifier(sectionText, new RegExp(`${qualifierRegex.source}[_-]?Hi|${qualifierRegex.source}[_-]?High`, 'i'));
  const lo = extractByteByQualifier(sectionText, new RegExp(`${qualifierRegex.source}[_-]?Lo|${qualifierRegex.source}[_-]?Low`, 'i'));
  if (hi && lo) {
    return `0x${hi}${lo}`;
  }

  const pairPattern = new RegExp(`<QUAL>([^<]+)</QUAL>[\\s\\S]{0,260}?<ENUM\\b[^>]*\\bv=['\"]([^'\"]+)['\"]`, 'gi');
  const bytes: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pairPattern.exec(sectionText))) {
    if (!qualifierRegex.test(match[1])) {
      continue;
    }
    const byte = toHexByte(match[2]);
    if (byte) {
      bytes.push(byte);
    }
    if (bytes.length >= 2) {
      break;
    }
  }
  if (bytes.length >= 2) {
    return `0x${bytes[0]}${bytes[1]}`;
  }
  return undefined;
}

function resolveIdentifierKind(sid: string, source: 'did' | 'rid' | 'other'): string {
  if (source === 'rid') {
    return 'RID';
  }
  if (source === 'did') {
    return 'DID';
  }
  if (sid.toUpperCase() === '0X31') {
    return 'RID';
  }
  return '-';
}

function resolveServiceTypeLabel(sid: string, semantic: string, serviceName: string): string {
  const upperSid = sid.toUpperCase();
  const sidMap: Record<string, string> = {
    '0X10': 'DiagnosticSessionControl',
    '0X11': 'ECUReset',
    '0X14': 'ClearDiagnosticInformation',
    '0X19': 'ReadDTCInformation',
    '0X22': 'ReadDataByIdentifier',
    '0X2A': 'ReadDataByPeriodicIdentifier',
    '0X2C': 'DynamicallyDefineDataIdentifier',
    '0X2E': 'WriteDataByIdentifier',
    '0X2F': 'InputOutputControlByIdentifier',
    '0X31': 'RoutineControl',
    '0X3D': 'WriteMemoryByAddress',
    '0X3E': 'TesterPresent',
    '0X85': 'ControlDTCSetting'
  };
  if (sidMap[upperSid]) {
    return sidMap[upperSid];
  }
  if (semantic && semantic !== '-') {
    return semantic;
  }
  return serviceName;
}

function extractByteByQualifier(sectionText: string, qualifierRegex: RegExp): string | undefined {
  const pattern = new RegExp(`<QUAL>([^<]+)</QUAL>[\\s\\S]{0,260}?<ENUM\\b[^>]*\\bv=['\"]([^'\"]+)['\"]`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sectionText))) {
    const qualifier = match[1];
    if (!qualifierRegex.test(qualifier)) {
      continue;
    }
    const byte = toHexByte(match[2]);
    if (byte) {
      return byte;
    }
  }
  return undefined;
}

function computePositiveSid(sid: string): string | undefined {
  if (!sid || sid === '-') {
    return undefined;
  }
  const normalized = sid.toUpperCase();
  if (!normalized.startsWith('0X')) {
    return undefined;
  }
  const value = Number.parseInt(normalized.slice(2), 16);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return `0x${(value + 0x40).toString(16).toUpperCase().padStart(2, '0')}`;
}

function buildNegativeResponseCodeMap(doc: vscode.TextDocument): Map<string, string> {
  const text = doc.getText();
  const map = new Map<string, string>();
  const regex = /<NEGRESCODE\b[^>]*id=['"]([^'"]+)['"][^>]*\bv=['"]([^'"]+)['"]/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    const id = match[1];
    const raw = match[2];
    map.set(id, normalizeHexOrDec(raw));
  }
  return map;
}

function readNodeAttributes(node: ArxmlNode): Record<string, string> {
  const doc = vscode.workspace.textDocuments.find(document => document.uri.toString() === node.file.toString());
  if (!doc) {
    return {};
  }
  const endLine = Math.min(node.range.start.line + 6, doc.lineCount - 1);
  const snippet = doc.getText(new vscode.Range(node.range.start.line, 0, endLine, doc.lineAt(endLine).text.length));
  const startTagMatch = snippet.match(new RegExp(`<${node.element}\\b([^>]*)>`));
  if (!startTagMatch) {
    return {};
  }
  const attributes: Record<string, string> = {};
  const attrPattern = /([A-Za-z0-9:_-]+)=['"]([^'"]*)['"]/g;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrPattern.exec(startTagMatch[1]))) {
    attributes[attrMatch[1]] = attrMatch[2];
  }
  return attributes;
}

function readNodeTagText(node: ArxmlNode, tagName: string): string | undefined {
  const doc = vscode.workspace.textDocuments.find(document => document.uri.toString() === node.file.toString());
  if (!doc) {
    return undefined;
  }
  const endLine = Math.min(node.range.start.line + 80, doc.lineCount - 1);
  const snippet = doc.getText(new vscode.Range(node.range.start.line, 0, endLine, doc.lineAt(endLine).text.length));
  const tagMatch = snippet.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i'));
  if (!tagMatch) {
    return undefined;
  }
  return tagMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractServiceId(service: ArxmlNode, sectionText: string): string | undefined {
  const sidByQualifier = sectionText.match(/<QUAL>SID[^<]*<\/QUAL>[\s\S]{0,300}?\bv=['"]([^'"]+)['"]/i);
  if (sidByQualifier) {
    return normalizeHexOrDec(sidByQualifier[1]);
  }

  const doc = vscode.workspace.textDocuments.find(document => document.uri.toString() === service.file.toString());
  if (!doc) {
    return undefined;
  }
  const endLine = Math.min(service.range.start.line + 20, doc.lineCount - 1);
  const snippet = doc.getText(new vscode.Range(service.range.start.line, 0, endLine, doc.lineAt(endLine).text.length));
  const enumValue = snippet.match(/<ENUM\b[^>]*\sv=['"]([^'"]+)['"][^>]*\/?>(?:\s*<\/ENUM>)?/i);
  if (!enumValue) {
    return undefined;
  }
  return normalizeHexOrDec(enumValue[1]);
}

function extractDid(...values: string[]): string | undefined {
  for (const value of values) {
    const didLabel = value.match(/DataIdentifier[_\s]*([0-9A-Fa-f]{4})/i);
    if (didLabel) {
      return `0x${didLabel[1].toUpperCase()}`;
    }
    const didCompact = value.match(/\bDID[_\s-]*([0-9A-Fa-f]{4})\b/i);
    if (didCompact) {
      return `0x${didCompact[1].toUpperCase()}`;
    }
    const match = value.match(/0x[0-9A-Fa-f]{2,6}/);
    if (match) {
      return match[0].toUpperCase();
    }
    const plain = value.match(/\b([0-9A-Fa-f]{4})\b/);
    if (plain) {
      return `0x${plain[1].toUpperCase()}`;
    }
  }
  return undefined;
}

function normalizeHexOrDec(raw: string): string {
  if (/^0x/i.test(raw)) {
    return raw.toUpperCase();
  }
  if (/^[0-9]+$/.test(raw)) {
    const numeric = Number(raw);
    return `0x${numeric.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return raw;
}
