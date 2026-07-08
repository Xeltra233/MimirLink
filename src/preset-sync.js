import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');

function ensureBindingConfig(config) {
    if (!config.bindings) {
        config.bindings = {
            global: {
                memoryDbPath: null,
                worldbook: null,
                preset: null,
                regexRules: null
            },
            characters: {}
        };
    }

    if (!config.bindings.global) {
        config.bindings.global = {
            memoryDbPath: null,
            worldbook: null,
            preset: null,
            regexRules: null
        };
    }

    if (!config.bindings.characters) {
        config.bindings.characters = {};
    }
}

function normalizeIdSet(ids) {
    if (!ids) return null;
    return new Set([...ids].map((id) => String(id || '')).filter(Boolean));
}

function isLoosePresetPayload(value) {
    return Boolean(
        value
        && typeof value === 'object'
        && value.type !== 'preset'
        && Array.isArray(value.prompts)
    );
}

function shouldImportLoosePresetFile(filename, options = {}) {
    if (!options.importLoosePresets) return false;
    if (options.skipRuntimeRawPreset !== false && /^runtime\.raw-preset\.json$/i.test(filename)) {
        return false;
    }
    return filename.endsWith('.json');
}

function buildLoosePresetImportRecord({ id, filename, preset, createdAt }) {
    const importedFields = Object.keys(preset).filter((key) => {
        const value = preset[key];
        return value !== '' && value !== false && value !== undefined;
    });
    return {
        id,
        type: 'preset',
        filename,
        presetName: String(preset.name || filename.replace(/\.json$/i, '') || '').trim() || null,
        createdAt,
        importedFields,
        importedPreset: preset,
        importedRegexRules: Array.isArray(preset.regexRules) ? preset.regexRules : [],
        linkedRegexImportId: null,
        previousRegexRules: [],
        previousPreset: {},
        sourceType: 'disk-preset',
        fileBackedOnly: true
    };
}

export function getPresetDataDir(config = {}) {
    return join(config.chat?.dataDir || join(ROOT_DIR, 'data'), 'presets');
}

export function syncPresetFiles(config, options = {}) {
    const presetsDir = getPresetDataDir(config);
    fs.mkdirSync(presetsDir, { recursive: true });
    const result = { imported: [], written: [], skipped: [] };

    try {
        ensureBindingConfig(config);
        config.imports = config.imports || {};
        config.imports.presetFiles = Array.isArray(config.imports.presetFiles)
            ? config.imports.presetFiles
            : [];

        const allowedDiskIds = normalizeIdSet(options.diskFileIds);
        const importPosition = options.importPosition === 'append' ? 'append' : 'prepend';

        const existingIds = new Set(config.imports.presetFiles.map((preset) => preset?.id).filter(Boolean));
        const diskFiles = fs.readdirSync(presetsDir).filter((file) => file.endsWith('.json')).sort();
        for (const file of diskFiles) {
            const id = file.replace(/\.json$/, '');
            if (allowedDiskIds && !allowedDiskIds.has(id)) {
                result.skipped.push({ id, reason: 'not-in-selected-restore-set' });
                continue;
            }
            if (existingIds.has(id)) continue;
            try {
                const filePath = join(presetsDir, file);
                const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (record && record.type === 'preset') {
                    if (!record.id) record.id = id;
                    if (importPosition === 'append') {
                        config.imports.presetFiles.push(record);
                    } else {
                        config.imports.presetFiles.unshift(record);
                    }
                    existingIds.add(record.id);
                    result.imported.push(record.id);
                } else if (shouldImportLoosePresetFile(file, options) && isLoosePresetPayload(record)) {
                    const stat = fs.statSync(filePath);
                    const importRecord = buildLoosePresetImportRecord({
                        id,
                        filename: file,
                        preset: record,
                        createdAt: stat.mtime.toISOString()
                    });
                    if (importPosition === 'append') {
                        config.imports.presetFiles.push(importRecord);
                    } else {
                        config.imports.presetFiles.unshift(importRecord);
                    }
                    existingIds.add(importRecord.id);
                    result.imported.push(importRecord.id);
                }
            } catch (error) {
                result.skipped.push({ id, reason: error.message });
            }
        }

        for (const record of config.imports.presetFiles) {
            if (!record?.id) continue;
            if (record.sourceType === 'disk-preset' || record.fileBackedOnly === true) continue;
            const filePath = join(presetsDir, `${record.id}.json`);
            try {
                fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
                result.written.push(record.id);
            } catch (error) {
                result.skipped.push({ id: record.id, reason: error.message });
            }
        }
    } catch (error) {
        result.skipped.push({ id: '', reason: error.message });
    }

    return result;
}
