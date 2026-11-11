import fs from 'node:fs';
import path from 'node:path';
import { createApplicationModel, createWorkspaceModel } from '../models/entities.js';

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
      const rawPlist = fs.readFileSync(infoPlistPath, 'utf8');
      plistData = parseMacOSPlistXml(rawPlist);
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

    const knownDataDirectories = matchedAdapter.getCandidateDataDirectories({
      name,
      bundleId,
      bundlePath: resolvedBundlePath,
      platformServices: this.platformServices
    });

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
      knownDataDirectories
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
