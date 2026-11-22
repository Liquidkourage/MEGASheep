const { Pool } = require('pg');
const dns = require('dns').promises;

let pool = null;
let resolvedUrl = null;

function rawUrls() {
    return {
        internal: process.env.DATABASE_URL || '',
        pub: process.env.DATABASE_PUBLIC_URL || ''
    };
}

async function resolveDatabaseUrl() {
    if (resolvedUrl != null) return resolvedUrl;
    const { internal, pub } = rawUrls();
    const candidate = internal || pub;
    if (!candidate) {
        resolvedUrl = '';
        return resolvedUrl;
    }
    if (/railway\.internal/i.test(candidate) && pub) {
        try {
            const host = new URL(candidate).hostname;
            await dns.lookup(host);
        } catch (_) {
            resolvedUrl = pub;
            return resolvedUrl;
        }
    }
    resolvedUrl = candidate;
    return resolvedUrl;
}

function makePool(url) {
    const needsSsl = /sslmode=require|rlwy\.net|railway\.app/i.test(url);
    return new Pool({
        connectionString: url,
        ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
        max: 5
    });
}

function getPool() {
    return pool;
}

function postgresEnabled() {
    return !!(rawUrls().internal || rawUrls().pub);
}

async function initPostgres() {
    const url = await resolveDatabaseUrl();
    if (!url) return false;
    if (!pool) pool = makePool(url);
    const p = pool;
    await p.query(`
        CREATE TABLE IF NOT EXISTS questions (
            id SERIAL PRIMARY KEY,
            prompt TEXT NOT NULL,
            correct_answers JSONB NOT NULL DEFAULT '[]'::jsonb,
            round INT DEFAULT 1,
            question_order INT DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS snapshots (
            id SERIAL PRIMARY KEY,
            game_code TEXT NOT NULL,
            phase TEXT,
            at TIMESTAMPTZ DEFAULT NOW(),
            snapshot JSONB
        );
        CREATE INDEX IF NOT EXISTS snapshots_game_code_at ON snapshots (game_code, at DESC);
    `);
    return true;
}

function rowToQuestion(row) {
    let answers = row.correct_answers;
    if (typeof answers === 'string') {
        try { answers = JSON.parse(answers); } catch (_) { answers = [answers]; }
    }
    return {
        id: row.id,
        prompt: row.prompt,
        round: row.round || 1,
        question_order: row.question_order || 1,
        correct_answers: Array.isArray(answers) ? answers.map(String) : []
    };
}

async function ensurePool() {
    if (!postgresEnabled()) return null;
    if (!pool) {
        try { await initPostgres(); } catch (e) {
            console.warn('Postgres init failed:', e.message);
            return null;
        }
    }
    return pool;
}

async function fetchPostgresQuestions() {
    const p = await ensurePool();
    if (!p) return [];
    try {
        const { rows } = await p.query(
            'SELECT id, prompt, correct_answers, round, question_order FROM questions ORDER BY round ASC, question_order ASC, id ASC'
        );
        return rows.map(rowToQuestion);
    } catch (e) {
        console.warn('Postgres questions query failed:', e.message);
        return [];
    }
}

async function appendPostgresQuestions(questions) {
    if (!Array.isArray(questions) || questions.length === 0) {
        throw new Error('No questions to append');
    }
    const p = await ensurePool();
    if (!p) throw new Error('DATABASE_URL is not set');
    const existing = await fetchPostgresQuestions();
    const seen = new Set(existing.map((q) => String(q.prompt || '').trim().toLowerCase()));
    const toAdd = questions.filter((q) => {
        const prompt = String(q.prompt || '').trim();
        if (!prompt) return false;
        const key = prompt.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    if (!toAdd.length) return { added: 0, total: existing.length };
    const client = await p.connect();
    try {
        await client.query('BEGIN');
        for (const q of toAdd) {
            await client.query(
                'INSERT INTO questions (prompt, correct_answers, round, question_order) VALUES ($1, $2::jsonb, $3, $4)',
                [q.prompt, JSON.stringify(q.correct_answers || []), q.round || 1, q.question_order || 1]
            );
        }
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        client.release();
    }
    return { added: toAdd.length, total: existing.length + toAdd.length };
}

async function replacePostgresQuestions(questions) {
    if (!Array.isArray(questions) || questions.length === 0) {
        throw new Error('Refusing to replace the question bank with an empty list');
    }
    const p = await ensurePool();
    if (!p) throw new Error('DATABASE_URL is not set');
    const client = await p.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM questions');
        for (const q of questions) {
            await client.query(
                'INSERT INTO questions (prompt, correct_answers, round, question_order) VALUES ($1, $2::jsonb, $3, $4)',
                [q.prompt, JSON.stringify(q.correct_answers || []), q.round || 1, q.question_order || 1]
            );
        }
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        client.release();
    }
}

async function insertPostgresSnapshot(payload) {
    const p = await ensurePool();
    if (!p) return false;
    try {
        await p.query(
            'INSERT INTO snapshots (game_code, phase, at, snapshot) VALUES ($1, $2, $3, $4::jsonb)',
            [payload.game_code, payload.phase || 'snapshot', payload.at || new Date().toISOString(), JSON.stringify(payload.snapshot || payload)]
        );
        return true;
    } catch (e) {
        console.warn('Postgres snapshot insert failed:', e.message);
        return false;
    }
}

async function loadLatestPostgresSnapshot(gameCode) {
    const p = await ensurePool();
    if (!p) return null;
    try {
        const { rows } = await p.query(
            'SELECT game_code, phase, at, snapshot FROM snapshots WHERE game_code = $1 ORDER BY at DESC LIMIT 1',
            [gameCode]
        );
        return rows[0] || null;
    } catch (e) {
        console.warn('Postgres snapshot load failed:', e.message);
        return null;
    }
}

async function listPostgresSnapshots(gameCode) {
    const p = await ensurePool();
    if (!p) return [];
    try {
        const { rows } = await p.query(
            'SELECT game_code, phase, at FROM snapshots WHERE game_code = $1 ORDER BY at DESC LIMIT 50',
            [gameCode]
        );
        return rows;
    } catch (_) {
        return [];
    }
}

module.exports = {
    postgresEnabled,
    initPostgres,
    fetchPostgresQuestions,
    appendPostgresQuestions,
    replacePostgresQuestions,
    insertPostgresSnapshot,
    loadLatestPostgresSnapshot,
    listPostgresSnapshots
};
