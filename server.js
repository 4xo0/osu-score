const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

async function getAccessToken(clientId, clientSecret) {
    try {
        const response = await axios.post('https://osu.ppy.sh/oauth/token', {
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'client_credentials',
            scope: 'public'
        });
        return response.data.access_token;
    } catch(error) {
        console.error('Error getting access token:', error.response ? error.response.data : error.message);
        throw new Error('Authentication failed. Check your Client ID and Client Secret.');
    }
}

app.post('/api/search', async (req, res) => {
    try {
        const {
            username,
            min_pp,
            max_pp,
            mods,
            limit,
            client_id,
            client_secret,
            type,
            include_fails
        } = req.body;

        if(!client_id || !client_secret) {
            return res.status(400).json({ error: 'Missing Client ID or Client Secret' });
        }

        const token = await getAccessToken(client_id, client_secret);

        let scores = [];
        const targetLimit = limit ? parseInt(limit) : 10;

        if(username && username.trim() !== '') {
            let userId = username;
            if(isNaN(username)) {
                 try {
                    const userResponse = await axios.get(`https://osu.ppy.sh/api/v2/users/@${username}?mode=osu`, {
                        headers: { Authorization: `Bearer ${token}` }
                    });
                    userId = userResponse.data.id;
                } catch(err) {
                     console.error("User lookup failed:", err.message);
                     return res.status(404).json({ error: 'User not found' });
                }
            }

            const endpoint = type === 'recent' ? 'recent' : 'best';

            const params = {
                mode: 'osu',
                limit: 100
            };

            if(type === 'recent' && include_fails) {
                params.include_fails = 1;
            }

            const scoresResponse = await axios.get(`https://osu.ppy.sh/api/v2/users/${userId}/scores/${endpoint}`, {
                params: params,
                headers: { Authorization: `Bearer ${token}` }
            });

            scores = scoresResponse.data;
        }
        else {
            let cursor = null;
            let fetchedCount = 0;

            const maxFetch = 10000;

            const startTime = Date.now();
            const timeLimit = 25000;

            while(scores.length < targetLimit && fetchedCount < maxFetch) {
                if(Date.now() - startTime > timeLimit) {
                    console.log("Search timed out, returning partial results.");
                    break;
                }

                const params = {
                    ruleset: 'osu',
                    limit: 50
                };

                if(cursor) {
                    params.cursor_string = cursor;
                }

                try {
                    const scoresResponse = await axios.get(`https://osu.ppy.sh/api/v2/scores`, {
                        params: params,
                        headers: { Authorization: `Bearer ${token}` }
                    });

                    let batchScores = [];
                    if(scoresResponse.data && scoresResponse.data.scores) {
                        batchScores = scoresResponse.data.scores;
                        cursor = scoresResponse.data.cursor_string;
                    } else if(Array.isArray(scoresResponse.data)) {
                        batchScores = scoresResponse.data;
                    }

                    if(batchScores.length === 0) break;

                    fetchedCount += batchScores.length;

                    const filteredBatch = normalizeAndFilter(batchScores, min_pp, max_pp, mods);
                    scores = scores.concat(filteredBatch);

                    if(!cursor && !scoresResponse.data.cursor) break;

                } catch(err) {
                    console.error("Error fetching global scores batch:", err.message);
                    break;
                }
            }
        }

        if(username && username.trim() !== '') {
            scores = normalizeAndFilter(scores, min_pp, max_pp, mods);
        }

        scores.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        const finalScores = scores.slice(0, targetLimit);

        const needsBeatmap = finalScores.some(s => !s.beatmap);
        const needsUser = finalScores.some(s => !s.user);

        if(needsBeatmap || needsUser) {
            const beatmapIds = [...new Set(finalScores.filter(s => !s.beatmap).map(s => s.beatmap_id))];
            const userIds = [...new Set(finalScores.filter(s => !s.user).map(s => s.user_id))];

            if(beatmapIds.length > 0) {
                const params = new URLSearchParams();
                beatmapIds.slice(0, 50).forEach(id => params.append('ids[]', id));

                try {
                    const bmResponse = await axios.get('https://osu.ppy.sh/api/v2/beatmaps', {
                        params: params,
                        headers: { Authorization: `Bearer ${token}` }
                    });
                    const fetchedBeatmaps = bmResponse.data.beatmaps || [];
                    finalScores.forEach(score => {
                        if(!score.beatmap) {
                            const bm = fetchedBeatmaps.find(b => b.id === score.beatmap_id);
                            if(bm) {
                                score.beatmap = bm;
                                if(bm.beatmapset && !score.beatmapset) score.beatmapset = bm.beatmapset;
                            }
                        }
                    });
                } catch(err) { console.error("Error fetching beatmaps:", err.message); }
            }

            if(userIds.length > 0) {
                const params = new URLSearchParams();
                userIds.slice(0, 50).forEach(id => params.append('ids[]', id));

                try {
                    const uResponse = await axios.get('https://osu.ppy.sh/api/v2/users', {
                        params: params,
                        headers: { Authorization: `Bearer ${token}` }
                    });
                    const fetchedUsers = uResponse.data.users || [];
                    finalScores.forEach(score => {
                        if(!score.user) {
                            score.user = fetchedUsers.find(u => u.id === score.user_id);
                        }
                    });
                } catch(err) { console.error("Error fetching users:", err.message); }
            }
        }

        res.json(finalScores);

    } catch(error) {
        console.error('Search error:', error.response ? error.response.data : error.message);
        const status = error.message.includes('Authentication failed') ? 401 : 500;
        res.status(status).json({ error: error.message, details: error.response ? error.response.data : null });
    }
});

function normalizeAndFilter(scores, min_pp, max_pp, mods) {
    return scores.map(score => {
        if(!score.created_at && score.ended_at) {
            score.created_at = score.ended_at;
        }
        if(score.mods && Array.isArray(score.mods)) {
            if(score.mods.length > 0 && typeof score.mods[0] === 'object' && score.mods[0].acronym) {
                score.mods = score.mods.map(m => m.acronym);
            }
        } else {
            score.mods = [];
        }
        score.pp = score.pp ? parseFloat(score.pp) : 0;
        return score;
    }).filter(score => {
        if(min_pp && score.pp < parseFloat(min_pp)) return false;
        if(max_pp && score.pp > parseFloat(max_pp)) return false;
        if(mods && mods.length > 0) {
            const hasAllMods = mods.every(mod => score.mods.includes(mod));
            if(!hasAllMods) return false;
        }
        return true;
    });
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});