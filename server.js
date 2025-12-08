require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

app.use(express.static('public'));
app.use(express.json());

let accessToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiry) return accessToken;

    try {
        const response = await axios.post('https://osu.ppy.sh/oauth/token', {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'client_credentials',
            scope: 'public'
        });
        accessToken = response.data.access_token;
        tokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000;
        return accessToken;
    } catch (error) {
        console.error('Token Error:', error.message);
        return null;
    }
}

async function fetchBeatmaps(beatmapIds) {
    if (beatmapIds.length === 0) return [];
    try {
        const token = await getAccessToken();
        if (!token) return [];

        const uniqueIds = [...new Set(beatmapIds)];
        const chunks = [];
        for (let i = 0; i < uniqueIds.length; i += 50) {
            chunks.push(uniqueIds.slice(i, i + 50));
        }

        let allBeatmaps = [];
        for (const chunk of chunks) {
            const params = new URLSearchParams();
            chunk.forEach(id => params.append('ids[]', id));

            const response = await axios.get('https://osu.ppy.sh/api/v2/beatmaps', {
                headers: { Authorization: `Bearer ${token}` },
                params: params
            });
            if (response.data && response.data.beatmaps) {
                allBeatmaps = [...allBeatmaps, ...response.data.beatmaps];
            }
        }
        return allBeatmaps;
    } catch (error) {
        console.error("Error fetching beatmaps:", error.message);
        return [];
    }
}

const userCache = new Map();

async function fetchUsers(userIds) {
    if (userIds.length === 0) return [];
    try {
        const token = await getAccessToken();
        if (!token) return [];

        const uniqueIds = [...new Set(userIds.filter(id => !userCache.has(id)))];
        if (uniqueIds.length === 0) return [];

        const chunks = [];
        for (let i = 0; i < uniqueIds.length; i += 50) {
            chunks.push(uniqueIds.slice(i, i + 50));
        }

        let fetchedUsers = [];
        for (const chunk of chunks) {
            const params = new URLSearchParams();
            chunk.forEach(id => params.append('ids[]', id));

            const response = await axios.get('https://osu.ppy.sh/api/v2/users', {
                headers: { Authorization: `Bearer ${token}` },
                params: params
            });
            if (response.data && response.data.users) {
                const users = response.data.users;
                users.forEach(u => userCache.set(u.id, u));
                fetchedUsers = [...fetchedUsers, ...users];
            }
        }
        return fetchedUsers;
    } catch (error) {
        console.error("Error fetching users:", error.message);
        return [];
    }
}

let lastScoreId = 0;
let recentScores = [];

async function pollScores() {
    try {
        const token = await getAccessToken();
        if (!token) return;

        const response = await axios.get('https://osu.ppy.sh/api/v2/scores', {
            headers: {
                Authorization: `Bearer ${token}`,
                'x-api-version': '20220705'
            },
            params: { ruleset: 'osu', limit: 50 }
        });

        const scores = response.data.scores || response.data;
        if (!Array.isArray(scores)) return;

        const newScores = scores.filter(s => s.id > lastScoreId);

        if (newScores.length === 0) return;

        lastScoreId = Math.max(...newScores.map(s => s.id));

        const missingBeatmapIds = newScores
            .filter(s => !s.beatmap || !s.beatmapset)
            .map(s => s.beatmap_id);

        const fetchedBeatmaps = await fetchBeatmaps(missingBeatmapIds);

        const missingUserIds = newScores
            .filter(s => !s.user)
            .map(s => s.user_id);

        await fetchUsers(missingUserIds);

        const processedScores = [];

        for (let score of newScores) {
            if (!score.created_at && score.ended_at) {
                score.created_at = score.ended_at;
            }

            if (!score.beatmap || !score.beatmapset) {
                const bm = fetchedBeatmaps.find(b => b.id === score.beatmap_id);
                if (bm) {
                    score.beatmap = bm;
                    score.beatmapset = bm.beatmapset;
                }
            }

            if (!score.user) {
                if (userCache.has(score.user_id)) {
                    score.user = userCache.get(score.user_id);
                }
            }

            processedScores.push(score);
        }

        processedScores.sort((a, b) => a.id - b.id);

        recentScores = [...recentScores, ...processedScores];
        if (recentScores.length > 50) {
            recentScores = recentScores.slice(recentScores.length - 50);
        }

        io.emit('new_scores', processedScores);

    } catch (error) {
        console.error('Polling Error:', error.message);
    }
}

setInterval(pollScores, 5000);

io.on('connection', (socket) => {
    console.log('Client connected');
    socket.emit('new_scores', recentScores);
    socket.on('disconnect', () => console.log('Client disconnected'));
});

app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
