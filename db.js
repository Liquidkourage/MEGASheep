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
        CREATE TABLE IF NOT EXISTS playlists (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS playlist_items (
            playlist_id INT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
            question_id INT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
            position INT NOT NULL DEFAULT 0,
            PRIMARY KEY (playlist_id, question_id)
        );
        CREATE INDEX IF NOT EXISTS playlist_items_question ON playlist_items (question_id);
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

async function upsertPostgresQuestion(question) {
    const p = await ensurePool();
    if (!p) throw new Error('DATABASE_URL is not set');
    const prompt = String(question && question.prompt || '').trim();
    if (!prompt) throw new Error('Question needs a prompt');
    const answers = Array.isArray(question.correct_answers) ? question.correct_answers.map(String) : [];
    const round = Number(question.round) || 1;
    const order = Number(question.question_order) || 1;
    const id = question.id == null || question.id === '' ? null : Number(question.id);
    if (id) {
        const { rows } = await p.query(
            'UPDATE questions SET prompt = $1, correct_answers = $2::jsonb, round = $3, question_order = $4 WHERE id = $5 RETURNING id, prompt, correct_answers, round, question_order',
            [prompt, JSON.stringify(answers), round, order, id]
        );
        if (!rows[0]) throw new Error('Question not found');
        return rowToQuestion(rows[0]);
    }
    const { rows } = await p.query(
        'INSERT INTO questions (prompt, correct_answers, round, question_order) VALUES ($1, $2::jsonb, $3, $4) RETURNING id, prompt, correct_answers, round, question_order',
        [prompt, JSON.stringify(answers), round, order]
    );
    return rowToQuestion(rows[0]);
}

async function deletePostgresQuestion(id) {
    const p = await ensurePool();
    if (!p) throw new Error('DATABASE_URL is not set');
    const { rowCount } = await p.query('DELETE FROM questions WHERE id = $1', [Number(id)]);
    return rowCount > 0;
}

async function fetchPostgresPlaylists() {
    const p = await ensurePool();
    if (!p) return [];
    const { rows } = await p.query(
        `SELECT p.id, p.name,
                COALESCE(json_agg(i.question_id ORDER BY i.position, i.question_id) FILTER (WHERE i.question_id IS NOT NULL), '[]'::json) AS question_ids
         FROM playlists p
         LEFT JOIN playlist_items i ON i.playlist_id = p.id
         GROUP BY p.id, p.name
         ORDER BY p.name ASC, p.id ASC`
    );
    return rows.map((row) => {
        let ids = row.question_ids;
        if (typeof ids === 'string') {
            try { ids = JSON.parse(ids); } catch (_) { ids = []; }
        }
        const questionIds = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite);
        return { id: row.id, name: row.name, questionIds, count: questionIds.length };
    });
}

async function savePostgresPlaylist(playlist) {
    const p = await ensurePool();
    if (!p) throw new Error('DATABASE_URL is not set');
    const name = String(playlist && playlist.name || '').trim();
    if (!name) throw new Error('Playlist needs a name');
    const questionIds = (Array.isArray(playlist.questionIds) ? playlist.questionIds : [])
        .map(Number)
        .filter(Number.isFinite);
    const client = await p.connect();
    try {
        await client.query('BEGIN');
        let id = playlist.id == null || playlist.id === '' ? null : Number(playlist.id);
        if (id) {
            const updated = await client.query('UPDATE playlists SET name = $1 WHERE id = $2 RETURNING id, name', [name, id]);
            if (!updated.rows[0]) throw new Error('Playlist not found');
            id = updated.rows[0].id;
            await client.query('DELETE FROM playlist_items WHERE playlist_id = $1', [id]);
        } else {
            const inserted = await client.query('INSERT INTO playlists (name) VALUES ($1) RETURNING id, name', [name]);
            id = inserted.rows[0].id;
        }
        for (let i = 0; i < questionIds.length; i += 1) {
            await client.query(
                'INSERT INTO playlist_items (playlist_id, question_id, position) VALUES ($1, $2, $3) ON CONFLICT (playlist_id, question_id) DO NOTHING',
                [id, questionIds[i], i]
            );
        }
        await client.query('COMMIT');
        const all = await fetchPostgresPlaylists();
        return all.find((row) => Number(row.id) === Number(id)) || { id, name, questionIds, count: questionIds.length };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        client.release();
    }
}

async function deletePostgresPlaylist(id) {
    const p = await ensurePool();
    if (!p) throw new Error('DATABASE_URL is not set');
    const { rowCount } = await p.query('DELETE FROM playlists WHERE id = $1', [Number(id)]);
    return rowCount > 0;
}

async function setPostgresQuestionPlaylists(questionId, playlistIds) {
    const p = await ensurePool();
    if (!p) throw new Error('DATABASE_URL is not set');
    const qid = Number(questionId);
    const wanted = [...new Set((Array.isArray(playlistIds) ? playlistIds : []).map(Number).filter(Number.isFinite))];
    const client = await p.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM playlist_items WHERE question_id = $1', [qid]);
        for (const playlistId of wanted) {
            const { rows } = await client.query(
                'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM playlist_items WHERE playlist_id = $1',
                [playlistId]
            );
            const position = Number(rows[0] && rows[0].next) || 0;
            await client.query(
                'INSERT INTO playlist_items (playlist_id, question_id, position) VALUES ($1, $2, $3) ON CONFLICT (playlist_id, question_id) DO NOTHING',
                [playlistId, qid, position]
            );
        }
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        client.release();
    }
    return fetchPostgresPlaylists();
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
    upsertPostgresQuestion,
    deletePostgresQuestion,
    fetchPostgresPlaylists,
    savePostgresPlaylist,
    deletePostgresPlaylist,
    setPostgresQuestionPlaylists,
    insertPostgresSnapshot,
    loadLatestPostgresSnapshot,
    listPostgresSnapshots
};
