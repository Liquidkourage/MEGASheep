const fs = require('fs');
const path = require('path');
const {
    postgresEnabled,
    fetchPostgresQuestions,
    fetchPostgresPlaylists,
    upsertPostgresQuestion,
    deletePostgresQuestion,
    savePostgresPlaylist,
    deletePostgresPlaylist,
    setPostgresQuestionPlaylists
} = require('./db');
const { loadQuestionsFromFile } = require('./loadQuestions');

const FILE = process.env.MEGASHEEP_LIBRARY_FILE || path.join(__dirname, 'data', 'question-library.json');

function emptyStore() {
    return { nextQuestionId: 1, nextPlaylistId: 1, questions: [], playlists: [] };
}

function readDisk() {
    try {
        if (!fs.existsSync(FILE)) return emptyStore();
        const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return {
            nextQuestionId: Number(parsed.nextQuestionId) || 1,
            nextPlaylistId: Number(parsed.nextPlaylistId) || 1,
            questions: Array.isArray(parsed.questions) ? parsed.questions : [],
            playlists: Array.isArray(parsed.playlists) ? parsed.playlists : []
        };
    } catch (_) {
        return emptyStore();
    }
}

function writeDisk(store) {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store, null, 2), 'utf8');
}

function normalizeQuestion(q, fallbackId) {
    const answers = Array.isArray(q && q.correct_answers) ? q.correct_answers.map(String) : [];
    const rawId = q && q.id != null ? q.id : fallbackId;
    const numericId = Number(rawId);
    return {
        id: Number.isFinite(numericId) ? numericId : rawId,
        prompt: String(q && q.prompt || '').trim(),
        round: Number(q && q.round) || 1,
        question_order: Number(q && q.question_order) || 1,
        correct_answers: answers
    };
}

function shapePlaylist(p) {
    const questionIds = (Array.isArray(p && p.questionIds) ? p.questionIds : []).map(Number).filter(Number.isFinite);
    return {
        id: p.id,
        name: String(p && p.name || '').trim(),
        questionIds,
        count: questionIds.length
    };
}

async function loadLibrary() {
    if (postgresEnabled()) {
        try {
            const questions = await fetchPostgresQuestions();
            const playlists = await fetchPostgresPlaylists();
            return { questions, playlists, source: 'database' };
        } catch (e) {
            console.warn('Library postgres load failed, using disk:', e.message);
        }
    }
    let store = readDisk();
    if (!store.questions.length) {
        try {
            const filePath = path.join(__dirname, 'sample-questions.txt');
            if (fs.existsSync(filePath)) {
                const parsed = await loadQuestionsFromFile(filePath);
                if (Array.isArray(parsed) && parsed.length) {
                    store.questions = parsed.map((q, i) => normalizeQuestion(q, i + 1));
                    store.nextQuestionId = store.questions.length + 1;
                    writeDisk(store);
                }
            }
        } catch (e) {
            console.warn('Could not seed local library from sample-questions.txt:', e.message);
        }
    }
    return {
        questions: store.questions.map((q) => normalizeQuestion(q, q.id)),
        playlists: store.playlists.map(shapePlaylist),
        source: 'file'
    };
}

async function saveQuestion(input) {
    if (postgresEnabled()) {
        try {
            return { question: await upsertPostgresQuestion(input), source: 'database' };
        } catch (e) {
            if (/DATABASE_URL|not set/i.test(e.message)) {
                /* fall through */
            } else {
                throw e;
            }
        }
    }
    const store = readDisk();
    const existingIndex = store.questions.findIndex((q) => String(q.id) === String(input.id));
    let saved;
    if (existingIndex >= 0) {
        saved = normalizeQuestion({ ...store.questions[existingIndex], ...input }, store.questions[existingIndex].id);
        if (!saved.prompt) throw new Error('Question needs a prompt');
        store.questions[existingIndex] = saved;
    } else {
        saved = normalizeQuestion({ ...input, id: store.nextQuestionId }, store.nextQuestionId);
        if (!saved.prompt) throw new Error('Question needs a prompt');
        store.nextQuestionId += 1;
        saved.question_order = store.questions.length + 1;
        store.questions.push(saved);
    }
    writeDisk(store);
    return { question: saved, source: 'file' };
}

async function deleteQuestion(id) {
    if (postgresEnabled()) {
        try {
            return { ok: await deletePostgresQuestion(id), source: 'database' };
        } catch (e) {
            if (!/DATABASE_URL|not set/i.test(e.message)) throw e;
        }
    }
    const store = readDisk();
    const before = store.questions.length;
    store.questions = store.questions.filter((q) => String(q.id) !== String(id));
    store.playlists = store.playlists.map((p) => ({
        ...p,
        questionIds: (p.questionIds || []).filter((qid) => String(qid) !== String(id))
    }));
    writeDisk(store);
    return { ok: store.questions.length < before, source: 'file' };
}

async function savePlaylist(input) {
    if (postgresEnabled()) {
        try {
            return { playlist: await savePostgresPlaylist(input), source: 'database' };
        } catch (e) {
            if (!/DATABASE_URL|not set/i.test(e.message)) throw e;
        }
    }
    const store = readDisk();
    const name = String(input && input.name || '').trim();
    if (!name) throw new Error('Playlist needs a name');
    const questionIds = [...new Set((Array.isArray(input.questionIds) ? input.questionIds : []).map(Number).filter(Number.isFinite))];
    let playlist;
    const idx = store.playlists.findIndex((p) => String(p.id) === String(input.id));
    if (idx >= 0) {
        playlist = shapePlaylist({ ...store.playlists[idx], name, questionIds });
        store.playlists[idx] = playlist;
    } else {
        playlist = shapePlaylist({ id: store.nextPlaylistId, name, questionIds });
        store.nextPlaylistId += 1;
        store.playlists.push(playlist);
    }
    writeDisk(store);
    return { playlist, source: 'file' };
}

async function deletePlaylist(id) {
    if (postgresEnabled()) {
        try {
            return { ok: await deletePostgresPlaylist(id), source: 'database' };
        } catch (e) {
            if (!/DATABASE_URL|not set/i.test(e.message)) throw e;
        }
    }
    const store = readDisk();
    const before = store.playlists.length;
    store.playlists = store.playlists.filter((p) => String(p.id) !== String(id));
    writeDisk(store);
    return { ok: store.playlists.length < before, source: 'file' };
}

async function setQuestionPlaylists(questionId, playlistIds) {
    if (postgresEnabled()) {
        try {
            const playlists = await setPostgresQuestionPlaylists(questionId, playlistIds);
            return { playlists, source: 'database' };
        } catch (e) {
            if (!/DATABASE_URL|not set/i.test(e.message)) throw e;
        }
    }
    const store = readDisk();
    const qid = Number(questionId);
    const wanted = new Set((Array.isArray(playlistIds) ? playlistIds : []).map(Number).filter(Number.isFinite));
    store.playlists = store.playlists.map((p) => {
        let ids = (p.questionIds || []).map(Number).filter(Number.isFinite);
        ids = ids.filter((id) => id !== qid);
        if (wanted.has(Number(p.id))) ids.push(qid);
        return shapePlaylist({ ...p, questionIds: ids });
    });
    writeDisk(store);
    return { playlists: store.playlists.map(shapePlaylist), source: 'file' };
}

async function questionsForPlaylists(playlistIds) {
    const lib = await loadLibrary();
    const wanted = (Array.isArray(playlistIds) ? playlistIds : []).map(String);
    const byId = new Map(lib.questions.map((q) => [String(q.id), q]));
    const seen = new Set();
    const questions = [];
    for (const playlist of lib.playlists) {
        if (!wanted.includes(String(playlist.id))) continue;
        for (const qid of playlist.questionIds || []) {
            const key = String(qid);
            if (seen.has(key)) continue;
            const question = byId.get(key);
            if (!question) continue;
            seen.add(key);
            questions.push(question);
        }
    }
    return questions;
}

module.exports = {
    loadLibrary,
    saveQuestion,
    deleteQuestion,
    savePlaylist,
    deletePlaylist,
    setQuestionPlaylists,
    questionsForPlaylists
};
