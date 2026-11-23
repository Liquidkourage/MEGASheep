'use strict';

function parseCsv(text) {
    const source = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        if (inQuotes) {
            if (ch === '"') {
                if (source[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
            continue;
        }
        if (ch === ',') {
            row.push(field);
            field = '';
            continue;
        }
        if (ch === '\n') {
            if (field.endsWith('\r')) field = field.slice(0, -1);
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            continue;
        }
        field += ch;
    }
    if (inQuotes) throw new Error('CSV has an unclosed quote');
    if (field.length || row.length) {
        if (field.endsWith('\r')) field = field.slice(0, -1);
        row.push(field);
        rows.push(row);
    }
    return rows.filter((cells) => cells.some((cell) => String(cell || '').trim()));
}

function headerIndex(headers) {
    const map = {};
    headers.forEach((name, i) => {
        map[String(name || '').trim().toLowerCase()] = i;
    });
    return map;
}

function cell(row, index, fallback) {
    if (index == null || index < 0) return fallback;
    return row[index] == null ? fallback : row[index];
}

function uniqueAnswers(values) {
    const out = [];
    const seen = new Set();
    values.forEach((value) => {
        const text = String(value == null ? '' : value).trim();
        if (!text) return;
        const key = text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(text);
    });
    return out;
}

function answersFromRow(answersField, aliasesField) {
    const listed = String(answersField || '').split('|').map((part) => part.trim()).filter(Boolean);
    let aliases = {};
    const raw = String(aliasesField || '').trim();
    if (raw && raw !== '{}') {
        try {
            aliases = JSON.parse(raw);
        } catch (_) {
            aliases = {};
        }
    }
    const collected = [...listed];
    Object.keys(aliases || {}).forEach((canonical) => {
        collected.push(canonical);
        const extras = aliases[canonical];
        if (Array.isArray(extras)) extras.forEach((alias) => collected.push(alias));
    });
    return uniqueAnswers(collected);
}

function parseQuestionCsv(text) {
    const rows = parseCsv(text);
    if (!rows.length) return { questions: [], errors: ['That CSV is empty.'] };
    const idx = headerIndex(rows[0]);
    const promptAt = idx.question != null ? idx.question : idx.prompt;
    const answersAt = idx.answers != null ? idx.answers : idx.correct_answers;
    if (promptAt == null || answersAt == null) {
        return { questions: [], errors: ['Need a header row with question and answers columns.'] };
    }
    const questions = [];
    const errors = [];
    rows.slice(1).forEach((row, i) => {
        const prompt = String(cell(row, promptAt, '')).trim();
        const answers = answersFromRow(cell(row, answersAt, ''), cell(row, idx.aliases_json, ''));
        if (!prompt) {
            errors.push('Row ' + (i + 2) + ' is missing a question.');
            return;
        }
        if (!answers.length) {
            errors.push('Row ' + (i + 2) + ' has no answers.');
            return;
        }
        questions.push({
            prompt,
            correct_answers: answers,
            category: String(cell(row, idx.category, '')).trim() || undefined,
            externalId: String(cell(row, idx.id, '')).trim() || undefined
        });
    });
    return { questions, errors };
}

function playlistNameFromFilename(filename) {
    const base = String(filename || '')
        .replace(/^.*[\\/]/, '')
        .replace(/\.[^.]+$/, '')
        .replace(/[_]+/g, ' ')
        .trim();
    return base || 'Imported playlist';
}

module.exports = {
    parseCsv,
    parseQuestionCsv,
    playlistNameFromFilename
};
