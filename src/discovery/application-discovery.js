import fs from 'node:fs';
import path from 'node:path';
import { createApplicationModel, createWorkspaceModel } from '../models/entities.js';
import { discoverApplicationFootprint } from './app-footprint.js';

/**
 * Minimal reader for binary property lists (`bplist00`), which some application bundles ship
 * instead of XML. Returns the top-level dictionary's string / integer / boolean values only.
 */
export function parseMacOSBinaryPlist(buffer) {
  const result = {};
  if (!Buffer.isBuffer(buffer) || buffer.length < 40 || buffer.toString('latin1', 0, 6) !== 'bplist') {
    return result;
  }
  try {
    const trailer = buffer.subarray(buffer.length - 32);
    const offsetIntSize = trailer[6];
    const refSize = trailer[7];
    const numObjects = Number(trailer.readBigUInt64BE(8));
    const topObject = Number(trailer.readBigUInt64BE(16));
    const offsetTableOffset = Number(trailer.readBigUInt64BE(24));
    if (!offsetIntSize || !refSize || numObjects > 1_000_000) {
      return result;
    }

    const readUInt = (pos, size) => {
      let value = 0;
      for (let i = 0; i < size; i++) {
        value = value * 256 + buffer[pos + i];
      }
      return value;
    };
    const objectOffset = (index) => readUInt(offsetTableOffset + index * offsetIntSize, offsetIntSize);

    // Returns [length, positionAfterLengthBytes] for variable-length objects
    const readLength = (pos) => {
      const low = buffer[pos] & 0x0f;
      if (low !== 0x0f) {
        return [low, pos + 1];
      }
      const intSize = 1 << (buffer[pos + 1] & 0x0f);
      return [readUInt(pos + 2, intSize), pos + 2 + intSize];
    };

    const readScalar = (index) => {
      if (index >= numObjects) return undefined;
      const pos = objectOffset(index);
      const marker = buffer[pos];
      const type = marker >> 4;
      if (marker === 0x08) return false;
      if (marker === 0x09) return true;
      if (type === 0x1) return readUInt(pos + 1, 1 << (marker & 0x0f));
      if (type === 0x5) {
        const [len, start] = readLength(pos);
        return buffer.toString('latin1', start, start + len);
      }
      if (type === 0x6) {
        const [len, start] = readLength(pos);
        return Buffer.from(buffer.subarray(start, start + len * 2)).swap16().toString('utf16le');
      }
      return undefined;
    };

    const topPos = objectOffset(topObject);
    if (buffer[topPos] >> 4 !== 0xd) {
      return result;
    }
    const [count, refsStart] = readLength(topPos);
    for (let i = 0; i < count; i++) {
      const key = readScalar(readUInt(refsStart + i * refSize, refSize));
      const value = readScalar(readUInt(refsStart + (count + i) * refSize, refSize));
      if (typeof key === 'string' && value !== undefined) {
        result[key] = value;
      }
    }
  } catch {
    // Truncated or malformed plist: keep whatever was decoded
  }
  return result;
}

/**
 * Lightweight, dependency-free parser for macOS XML Info.plist files.
 * Never executes any external binary or the target application bundle.
 */
export function parseMacOSPlistXml(xmlContent) {
  const result = {};
  if (!xmlContent || typeof xmlContent !== 'string') {
    return result;
  }

  const trimmed = xmlContent.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return result;
    }
  }

  // Extract top-level <key>...</key> followed by <string>, <true/>, <false/>, <integer>
  const pairRegex =
    /<key>\s*([^<]+?)\s*<\/key>\s*(?:<string>\s*([\s\S]*?)\s*<\/string>|<(true|false)\s*\/>|<integer>\s*([^<]+?)\s*<\/integer>)/gi;

  let match;
  while ((match = pairRegex.exec(xmlContent)) !== null) {
    const key = decodeXmlEntities(match[1].trim());
    if (match[2] !== undefined) {
      result[key] = decodeXmlEntities(match[2].trim());
    } else if (match[3] !== undefined) {
      result[key] = match[3].toLowerCase() === 'true';
    } else if (match[4] !== undefined) {
      result[key] = Number(match[4].trim());
    }
  }

  return result;
}

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export class ApplicationDiscovery {
  constructor({ platformServices, adapterRegistry }) {
    this.platformServices = platformServices;
    this.adapterRegistry = adapterRegistry;
  }

  /**
   * Inspects a macOS .app bundle without executing it.
   */
  identifyAppBundle(bundlePath) {
    const resolvedBundlePath = path.resolve(bundlePath);

    if (!fs.existsSync(resolvedBundlePath)) {
      throw new Error(`Application bundle not found at path: ${resolvedBundlePath}`);
    }

    const stat = fs.lstatSync(resolvedBundlePath);
    if (!stat.isDirectory() || !resolvedBundlePath.endsWith('.app')) {
      throw new Error(`Expected a macOS .app bundle directory, got: ${ path.basename(resolvedBundlePath) }`);
    }

    const contentsDir = path.join(resolvedBundlePath, 'Contents');
    const infoPlistPath = path.join(contentsDir, 'Info.plist');
    let plistData = {};

    if (fs.existsSync(infoPlistPath)) {
      const rawPlist = fs.readFileSync(infoPlistPath);
      plistData =
        rawPlist.toString('latin1', 0, 6) === 'bplist'
          ? parseMacOSBinaryPlist(rawPlist)
          : parseMacOSPlistXml(rawPlist.toString('utf8'));
    }

    const fallbackName = path.basename(resolvedBundlePath, '.app');
    const name =
      plistData.CFBundleDisplayName ||
      plistData.CFBundleName ||
      fallbackName;
    const bundleId = plistData.CFBundleIdentifier || null;
    const executableName = plistData.CFBundleExecutable || fallbackName;
    const executableCandidate = path.join(contentsDir, 'MacOS', executableName);
    const executablePath = fs.existsSync(executableCandidate) ? executableCandidate : null;
    const version =
      plistData.CFBundleShortVersionString ||
      plistData.CFBundleVersion ||
      'Unknown';

    const codeSignatureExists = fs.existsSync(path.join(contentsDir, '_CodeSignature'));
    const developerMetadata = {
      copyright: plistData.NSHumanReadableCopyright || null,
      bundleSignature: plistData.CFBundleSignature || null,
      minimumSystemVersion: plistData.LSMinimumSystemVersion || null,
      categoryType: plistData.LSApplicationCategoryType || null,
      isCodeSignedStructurePresent: codeSignatureExists
    };

    const matchedAdapter = this.adapterRegistry.resolveAdapterForApp({
      name,
      bundleId,
      bundlePath: resolvedBundlePath
    });

    const adapterDirectories = matchedAdapter.getCandidateDataDirectories({
      name,
      bundleId,
      bundlePath: resolvedBundlePath,
      platformServices: this.platformServices
    });

    // Generic footprint discovery runs for every application, with or without a session
    // adapter: Library containers, sandbox containers, and hidden home dot-directories that
    // are named after the app or its bundle identifier.
    const footprint = discoverApplicationFootprint({
      name,
      bundleId,
      bundleFileName: fallbackName,
      platformServices: this.platformServices
    });
    const knownDataDirectories = [...adapterDirectories];
    const knownPaths = new Set(adapterDirectories.map((d) => path.resolve(d.path)));
    for (const location of footprint.locations) {
      if (!knownPaths.has(location.path)) {
        knownPaths.add(location.path);
        knownDataDirectories.push(location);
      }
    }

    return createApplicationModel({
      name,
      bundleId,
      bundlePath: resolvedBundlePath,
      executablePath,
      version: String(version),
      developerMetadata,
      adapterId: matchedAdapter.id,
      isSupportedAIApp: matchedAdapter.isSpecializedAIAdapter,
      recognitionStatus: matchedAdapter.isSpecializedAIAdapter
        ? 'VERIFIED_AI_ADAPTER'
        : 'GENERIC_MACOS_ADAPTER',
      knownDataDirectories,
      isKnownAIApp: matchedAdapter.isSpecializedAIAdapter || footprint.isKnownAIApp,
      unreadableContainers: footprint.unreadableContainers
    });
  }

  /**
   * Allows manual selection of a project/workspace directory for analysis.
   */
  identifyWorkspaceDirectory(workspacePath, associatedAppIds = []) {
    const resolvedPath = this.platformServices.resolveRealPathSafe(workspacePath);
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
      throw new Error(`Workspace directory does not exist: ${resolvedPath}`);
    }

    const hasGitRepository = fs.existsSync(path.join(resolvedPath, '.git'));
    return createWorkspaceModel({
      name: path.basename(resolvedPath),
      canonicalPath: resolvedPath,
      applicationIds: associatedAppIds,
      hasGitRepository
    });
  }
}
