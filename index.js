'use strict';

// ============================================================
// 📦 IMPORTS
// ============================================================
const {
    Client,
    GatewayIntentBits,
    AuditLogEvent,
    PermissionFlagsBits,
    ChannelType,
    EmbedBuilder,
    OverwriteType,
    ButtonBuilder,       // ← NOUVEAU (tickets)
    ButtonStyle,         // ← NOUVEAU (tickets)
    ActionRowBuilder,    // ← NOUVEAU (tickets)
    AttachmentBuilder,   // ← NOUVEAU (tickets / transcripts)
} = require('discord.js');
const http = require('http');

// ============================================================
// 🌐 SERVEUR WEB — KEEP-ALIVE POUR RENDER
// ============================================================
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot Discord en ligne !');
});
server.listen(process.env.PORT || 10000, () =>
    console.log(`[WEB] Serveur démarré sur le port ${process.env.PORT || 10000}`)
);

// ============================================================
// ⚙️ CONFIGURATION
// ============================================================
const PREFIX = '+';

// IDs exemptés de la protection RAID et ayant accès à +kill
const EXEMPT_IDS = ['1102217912569319515', '1339332485930160189'];
const KILL_IDS   = ['1102217912569319515', '1339332485930160189'];

// Fenêtre glissante de détection RAID (10 minutes)
const RAID_WINDOW_MS = 10 * 60 * 1000;

// Seuils RAID — kick si le compteur DÉPASSE ces valeurs
const RAID_LIMITS = {
    channelDelete  : 3,
    roleDelete     : 2,
    categoryDelete : 1,
    permChange     : 5,
};

// Salons de logs pour chaque type d'action
const LOG = {
    commands   : '1519475032659857550',
    ban        : '1519473192652112002',
    tempban    : '1519472967640285313',
    mute       : '1519473215746080778',
    tempmute   : '1519473058102902976',
    allDeleted : '1519474678199095417',
    snipe      : '1519491455750508805',
    safe       : '1519473513042542724',
    raid       : '1519474527829229639',
    tickets    : '1519771795350098043', // ← Stockage persistant des tickets (sessions + panneaux)
};

// ============================================================
// 🤖 CLIENT DISCORD
// ⚠️  Les deux intents marqués "Privileged" doivent être
//     activés manuellement dans le Discord Developer Portal :
//     https://discord.com/developers/applications
//     → Ton app → Bot → Privileged Gateway Intents
// ============================================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,   // ⚠️ Privileged
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // ⚠️ Privileged
        GatewayIntentBits.GuildModeration,
    ],
});

// ============================================================
// 🔴 GESTIONNAIRES D'ERREURS GLOBAUX
// Empêche le bot de crasher sur une promesse rejetée non gérée
// ============================================================
client.on('error', (e) => console.error('[CLIENT ERROR]', e.message));

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err.message);
});

// ============================================================
// 🗂️ STOCKAGE EN MÉMOIRE
// ============================================================
const snipeStore    = new Map(); // channelId → snipe entry
const safeList      = new Set(); // userId    → whitelisté RAID
const tempBanTimers = new Map(); // userId    → timer auto-unban
const raidTracker   = new Map(); // `gId_uId` → compteurs RAID
const raidViolated  = new Set(); // `gId_uId` → déjà sanctionné (anti-double)

// ── Tickets ─────────────────────────────────────────────────
// ticketConfigs : configId → { categoryId, logsId, salonText,
//                              beforeSalonId, titleText, mainText }
const ticketConfigs  = new Map();

// ticketSessions : channelId → { openerId, claimedBy,
//                                guildId, configId, embedMsgId }
const ticketSessions = new Map();

// ============================================================
// 🛠️  HELPERS
// ============================================================

/** Envoie un embed dans un salon de log. Silencieux si le salon est introuvable. */
async function sendLog(guild, channelId, embed) {
    try {
        const ch = guild.channels.cache.get(channelId);
        if (ch?.isTextBased()) await ch.send({ embeds: [embed] });
    } catch (e) {
        console.error('[LOG]', e.message);
    }
}

/**
 * Récupère l'exécuteur du dernier audit log d'un type donné.
 * Attend 1 s pour que Discord ait mis à jour ses logs.
 */
async function getExecutor(guild, actionType) {
    try {
        await new Promise(r => setTimeout(r, 1000));
        const logs  = await guild.fetchAuditLogs({ type: actionType, limit: 1 });
        const entry = logs.entries.first();
        if (entry && Date.now() - entry.createdTimestamp < 5000) return entry.executor;
    } catch { /* ignore */ }
    return null;
}

/**
 * Récupère l'exécuteur du log le plus récent, tous types confondus.
 * Utilisé pour les changements de permissions (3 types possibles).
 */
async function getRecentExecutor(guild) {
    try {
        await new Promise(r => setTimeout(r, 1000));
        const logs  = await guild.fetchAuditLogs({ limit: 1 });
        const entry = logs.entries.first();
        if (entry && Date.now() - entry.createdTimestamp < 5000) return entry.executor;
    } catch { /* ignore */ }
    return null;
}

/** Retourne true si l'utilisateur est exempté de la protection RAID. */
function isExempt(user) {
    if (!user) return true;
    if (user.bot) return true;
    if (EXEMPT_IDS.includes(user.id)) return true;
    if (safeList.has(user.id)) return true;
    return false;
}

// ============================================================
// 🎫 HELPERS TICKETS
// ============================================================

/**
 * Parse les paramètres de la commande +CreateTicket.
 * Supporte Key:(valeur avec espaces) et Key:valeurSimple.
 */
function parseTicketArgs(content) {
    const params = {};
    // Paramètres avec parenthèses : Key:(valeur) — supporte espaces et caractères spéciaux
    const parenRegex = /(\w+):\(([^)]+)\)/gi;
    let m;
    while ((m = parenRegex.exec(content)) !== null) {
        params[m[1].toLowerCase()] = m[2].trim();
    }
    // Paramètres sans parenthèses : Key:valeur — jusqu'au prochain espace
    const simpleRegex = /(\w+):([^\s(][^\s]*)/gi;
    while ((m = simpleRegex.exec(content)) !== null) {
        const key = m[1].toLowerCase();
        if (!params[key]) params[key] = m[2].trim();
    }
    return params;
}

/**
 * Construit les boutons du panneau intérieur d'un ticket.
 * Séparé en fonction pour pouvoir les reconstruire facilement.
 */
function buildTicketRow(isClaimed = false, claimedById = null) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('ticket_close')
            .setLabel('🔒 Fermer le ticket')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('ticket_claim')
            .setLabel(isClaimed ? `✅ Pris en charge` : '🙋 Prendre en charge')
            .setStyle(isClaimed ? ButtonStyle.Secondary : ButtonStyle.Success)
            .setDisabled(isClaimed),
    );
    return row;
}

/**
 * Construit l'embed de tracking d'un TICKET OUVERT dans LOG.tickets.
 * La description contient un bloc JSON machine-readable pour la restauration.
 * Les champs affichent les infos humaines.
 *
 * @param {string} channelId   ID du salon ticket
 * @param {object} session     Objet session (ticketSessions)
 * @param {object} config      Objet config (ticketConfigs)
 */
function buildTicketTrackEmbed(channelId, session, config) {
    const payload = JSON.stringify({
        type         : 'ticket',
        channelId,
        openerId     : session.openerId,
        claimedBy    : session.claimedBy,
        guildId      : session.guildId,
        configId     : session.configId,
        embedMsgId   : session.embedMsgId,
        categoryId   : config.categoryId,
        logsId       : config.logsId,
        beforeSalonId: config.beforeSalonId,
        salonText    : config.salonText,
        titleText    : config.titleText,
        mainText     : config.mainText,
    });

    return new EmbedBuilder()
        .setColor(session.claimedBy ? 0xFEE75C : 0x57F287)
        .setTitle('🎫 Ticket actif')
        .setDescription('```json\n' + payload.slice(0, 4090) + '\n```')
        .addFields(
            { name: '🎫 Salon',         value: `<#${channelId}>`,                                              inline: true },
            { name: '👤 Ouvert par',    value: `<@${session.openerId}>`,                                       inline: true },
            { name: '🙋 Pris en charge',value: session.claimedBy ? `<@${session.claimedBy}>` : '*(aucun)*',   inline: true },
        )
        .setTimestamp();
}

/**
 * Construit l'embed de tracking d'un PANNEAU dans LOG.tickets.
 * Permet de restaurer les ticketConfigs au redémarrage (boutons d'ouverture).
 *
 * @param {string} configId   Clé de la config
 * @param {object} config     Objet config (ticketConfigs)
 * @param {string} panelChannelId  Salon où le panneau a été posté
 * @param {string} guildId    ID du serveur
 */
function buildPanelTrackEmbed(configId, config, panelChannelId, guildId) {
    const payload = JSON.stringify({
        type         : 'panel',
        configId,
        guildId,
        categoryId   : config.categoryId,
        logsId       : config.logsId,
        beforeSalonId: config.beforeSalonId,
        salonText    : config.salonText,
        titleText    : config.titleText,
        mainText     : config.mainText,
    });

    return new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📋 Panneau de tickets')
        .setDescription('```json\n' + payload.slice(0, 4090) + '\n```')
        .addFields(
            { name: '📌 Salon du panneau', value: `<#${panelChannelId}>`, inline: true },
            { name: '🗂️ Catégorie cible',  value: `<#${config.categoryId}>`, inline: true },
        )
        .setTimestamp();
}

// ============================================================
// 🛡️  SYSTÈME DE PROTECTION RAID
// ============================================================

/** Retourne (et initialise si besoin) les compteurs RAID d'un utilisateur. */
function getRaid(guildId, userId) {
    const key = `${guildId}_${userId}`;
    if (!raidTracker.has(key)) {
        raidTracker.set(key, { ch: 0, role: 0, cat: 0, perm: 0, timer: null });
    }
    const data = raidTracker.get(key);

    if (data.timer) clearTimeout(data.timer);
    data.timer = setTimeout(() => raidTracker.delete(key), RAID_WINDOW_MS);

    return data;
}

/** Sanctionne un utilisateur ayant déclenché la protection RAID. */
async function raidViolation(guild, userId, reason) {
    const key = `${guild.id}_${userId}`;
    if (raidViolated.has(key)) return;
    raidViolated.add(key);
    setTimeout(() => raidViolated.delete(key), 30_000);

    console.warn(`[RAID] Violation — ${userId} — ${reason}`);

    const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('🚨 RAID Protection — Violation détectée')
        .addFields(
            { name: 'Utilisateur', value: `<@${userId}> \`(${userId})\`` },
            { name: 'Raison',      value: reason },
        )
        .setTimestamp();

    await sendLog(guild, LOG.raid, embed);

    try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member) {
            await member.kick(`[RAID Protection] ${reason}`);
            await sendLog(guild, LOG.raid, new EmbedBuilder()
                .setColor(0xFF4444)
                .setDescription(`✅ **${member.user.tag}** a été expulsé automatiquement.`)
                .setTimestamp()
            );
        }
    } catch (e) {
        console.error('[RAID] Échec du kick :', e.message);
    }

    raidTracker.delete(key);
}

// ── Événement : suppression d'un salon / catégorie ──────────
client.on('channelDelete', async (channel) => {
    const guild = channel.guild;
    if (!guild) return;

    const executor = await getExecutor(guild, AuditLogEvent.ChannelDelete);
    if (!executor || isExempt(executor)) return;

    const data = getRaid(guild.id, executor.id);

    if (channel.type === ChannelType.GuildCategory) {
        data.cat++;
        if (data.cat > RAID_LIMITS.categoryDelete)
            await raidViolation(guild, executor.id,
                `Trop de suppressions de catégories (${data.cat}/${RAID_LIMITS.categoryDelete})`);
    } else {
        data.ch++;
        if (data.ch > RAID_LIMITS.channelDelete)
            await raidViolation(guild, executor.id,
                `Trop de suppressions de salons (${data.ch}/${RAID_LIMITS.channelDelete})`);
    }
});

// ── Événement : suppression d'un rôle ───────────────────────
client.on('roleDelete', async (role) => {
    const guild    = role.guild;
    const executor = await getExecutor(guild, AuditLogEvent.RoleDelete);
    if (!executor || isExempt(executor)) return;

    const data = getRaid(guild.id, executor.id);
    data.role++;
    if (data.role > RAID_LIMITS.roleDelete)
        await raidViolation(guild, executor.id,
            `Trop de suppressions de rôles (${data.role}/${RAID_LIMITS.roleDelete})`);
});

// ── Événement : modification des permissions d'un salon ─────
client.on('channelUpdate', async (oldCh, newCh) => {
    const guild = newCh.guild;
    if (!guild) return;

    const changed = (() => {
        try {
            const o = oldCh.permissionOverwrites?.cache;
            const n = newCh.permissionOverwrites?.cache;
            if (!o || !n) return false;
            if (o.size !== n.size) return true;
            return [...o.values()].some(op => {
                const np = n.get(op.id);
                return !np || !op.allow.equals(np.allow) || !op.deny.equals(np.deny);
            });
        } catch { return false; }
    })();
    if (!changed) return;

    const executor = await getRecentExecutor(guild);
    if (!executor || isExempt(executor)) return;

    const data = getRaid(guild.id, executor.id);
    data.perm++;
    if (data.perm > RAID_LIMITS.permChange)
        await raidViolation(guild, executor.id,
            `Trop de modifications de permissions (${data.perm}/${RAID_LIMITS.permChange})`);
});

// ============================================================
// 💬 SYSTÈME SNIPE — capture des messages supprimés
// ============================================================
client.on('messageDelete', async (message) => {
    if (message.partial || !message.guild) return;

    const deletedAt = Date.now();

    // ── 1. Log brut de TOUS les messages supprimés ──────────
    try {
        const desc = message.content || '*(pas de contenu textuel)*';
        const attachments = message.attachments.size > 0
            ? `\n📎 **${message.attachments.size} pièce(s) jointe(s)** : `
              + message.attachments.map(a => a.url).join(', ')
            : '';

        const logEmbed = new EmbedBuilder()
            .setColor(0xFF6B6B)
            .setTitle('🗑️ Message supprimé')
            .setDescription(desc + attachments)
            .addFields(
                { name: 'Auteur',   value: message.author
                    ? `${message.author.tag} \`(${message.author.id})\``
                    : '*(inconnu)*', inline: true },
                { name: 'Salon',    value: `<#${message.channel.id}>`, inline: true },
                { name: 'Supprimé', value: `<t:${Math.floor(deletedAt / 1000)}:R>`, inline: true },
            )
            .setTimestamp();

        await sendLog(message.guild, LOG.allDeleted, logEmbed);
    } catch (e) {
        console.error('[SNIPE-LOG]', e.message);
    }

    // ── 2. Stockage pour la commande +snipe ─────────────────
    if (!message.author || message.author.bot || !message.content) return;

    let context = [];
    try {
        const fetched = await message.channel.messages.fetch({
            before : message.id,
            limit  : 5,
        });
        context = [...fetched.values()]
            .reverse()
            .map(m => ({
                content   : m.content || '*(pas de texte)*',
                authorTag : m.author.tag,
                authorId  : m.author.id,
            }));
    } catch { /* channel inaccessible ou messages non mis en cache */ }

    snipeStore.set(message.channel.id, {
        content     : message.content,
        authorTag   : message.author.tag,
        authorId    : message.author.id,
        channelId   : message.channel.id,
        channelName : message.channel.name,
        deletedAt,
        context,
    });
});

// ============================================================
// 🔄 RESTAURATION DE L'ÉTAT AU DÉMARRAGE
// ============================================================
async function fetchBotLogs(guild, channelId) {
    const ch = guild.channels.cache.get(channelId);
    if (!ch?.isTextBased()) return [];
    const messages = await ch.messages.fetch({ limit: 100 });
    return [...messages.values()]
        .filter(m => m.author.id === client.user.id)
        .reverse();
}

async function restoreFromLogs(guild) {
    // ── 1. Reconstruction de la safeList ───────────────────
    try {
        const msgs = await fetchBotLogs(guild, LOG.safe);
        for (const msg of msgs) {
            const embed = msg.embeds[0];
            if (!embed?.title?.includes('Ajout')) continue;

            const field = embed.fields?.find(f => f.name === 'Membre protégé');
            if (!field) continue;

            const match = field.value.match(/`\((\d+)\)`/);
            if (!match) continue;

            safeList.add(match[1]);
        }
        console.log(`[RESTORE] safeList : ${safeList.size} membre(s) whitelisté(s)`);
    } catch (e) {
        console.error('[RESTORE] safeList :', e.message);
    }

    // ── 2. Reconstruction des timers de tempban ─────────────
    try {
        const msgs = await fetchBotLogs(guild, LOG.tempban);
        for (const msg of msgs) {
            const embed = msg.embeds[0];
            if (!embed?.title?.includes('Temp-Ban')) continue;

            const memberField   = embed.fields?.find(f => f.name === 'Membre');
            const durationField = embed.fields?.find(f => f.name === 'Durée');
            if (!memberField || !durationField) continue;

            const userMatch = memberField.value.match(/`\((\d+)\)`/);
            const hours     = parseFloat(durationField.value);
            if (!userMatch || isNaN(hours)) continue;

            const userId    = userMatch[1];
            const expireAt  = msg.createdTimestamp + hours * 3_600_000;
            const remaining = expireAt - Date.now();

            if (remaining <= 0) continue;
            if (tempBanTimers.has(userId)) clearTimeout(tempBanTimers.get(userId));

            tempBanTimers.set(userId, setTimeout(async () => {
                try {
                    await guild.bans.remove(userId, 'Expiration du tempban automatique (restauré)');
                    console.log(`[TEMPBAN] Unban automatique restauré : ${userId}`);
                } catch { /* déjà débanni manuellement */ }
                tempBanTimers.delete(userId);
            }, remaining));
        }
        console.log(`[RESTORE] tempBanTimers : ${tempBanTimers.size} timer(s) replanifié(s)`);
    } catch (e) {
        console.error('[RESTORE] tempBanTimers :', e.message);
    }

    // ── 3. Reconstruction des tickets et panneaux ───────────
    // On lit LOG.tickets : chaque message du bot contient un bloc JSON
    // décrivant soit un panneau (type:'panel') soit un ticket ouvert (type:'ticket').
    try {
        const trackCh = guild.channels.cache.get(LOG.tickets);
        if (!trackCh?.isTextBased()) {
            console.warn('[RESTORE] tickets : salon de tracking introuvable.');
        } else {
            const msgs = await trackCh.messages.fetch({ limit: 100 });
            const botMsgs = [...msgs.values()]
                .filter(m => m.author.id === client.user.id)
                .reverse(); // ordre chronologique

            let panelsRestored  = 0;
            let ticketsRestored = 0;
            let ticketsCleaned  = 0;

            for (const msg of botMsgs) {
                const embed = msg.embeds[0];
                if (!embed?.description) continue;

                // ── Extraction du bloc JSON ────────────────
                const jsonMatch = embed.description.match(/```json\n([\s\S]+?)\n```/);
                if (!jsonMatch) continue;

                let data;
                try {
                    data = JSON.parse(jsonMatch[1]);
                } catch (parseErr) {
                    console.error('[RESTORE] tickets — JSON invalide :', parseErr.message);
                    continue;
                }

                // ── CAS 1 : Panneau de tickets ─────────────
                // Restaure ticketConfigs pour que les boutons d'ouverture
                // déjà postés dans le serveur continuent de fonctionner.
                if (data.type === 'panel') {
                    if (!ticketConfigs.has(data.configId)) {
                        ticketConfigs.set(data.configId, {
                            categoryId   : data.categoryId,
                            logsId       : data.logsId,
                            salonText    : data.salonText,
                            beforeSalonId: data.beforeSalonId,
                            titleText    : data.titleText,
                            mainText     : data.mainText,
                        });
                        panelsRestored++;
                    }
                    continue;
                }

                // ── CAS 2 : Ticket ouvert ──────────────────
                if (data.type !== 'ticket') continue;

                // Vérifie que le salon ticket existe encore
                // (peut avoir été supprimé manuellement pendant le downtime)
                const ticketCh = guild.channels.cache.get(data.channelId);
                if (!ticketCh) {
                    // Salon disparu → on nettoie le log automatiquement
                    await msg.delete().catch(() => {});
                    ticketsCleaned++;
                    continue;
                }

                // Restaure la config si elle n'est pas déjà en mémoire
                if (!ticketConfigs.has(data.configId)) {
                    ticketConfigs.set(data.configId, {
                        categoryId   : data.categoryId,
                        logsId       : data.logsId,
                        salonText    : data.salonText,
                        beforeSalonId: data.beforeSalonId,
                        titleText    : data.titleText,
                        mainText     : data.mainText,
                    });
                }

                // Restaure la session
                ticketSessions.set(data.channelId, {
                    channelId  : data.channelId,
                    openerId   : data.openerId,
                    claimedBy  : data.claimedBy  || null,
                    guildId    : data.guildId,
                    configId   : data.configId,
                    embedMsgId : data.embedMsgId || null,
                    logMsgId   : msg.id,           // ID du message dans LOG.tickets
                });
                ticketsRestored++;
            }

            console.log(
                `[RESTORE] tickets : ${panelsRestored} panneau(x), ` +
                `${ticketsRestored} ticket(s) restauré(s), ` +
                `${ticketsCleaned} log(s) nettoyé(s) (salons disparus)`
            );
        }
    } catch (e) {
        console.error('[RESTORE] tickets :', e.message);
    }
}

// ============================================================
// 🎮 GESTIONNAIRE DE COMMANDES
// ============================================================
client.once('ready', async () => {
    console.log(`[BOT] ✅ Connecté en tant que ${client.user.tag}`);

    for (const [, guild] of client.guilds.cache) {
        await restoreFromLogs(guild);
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args    = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // ── Log systématique de chaque commande ─────────────────
    sendLog(message.guild, LOG.commands, new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📝 Commande exécutée')
        .setDescription(
            `**Commande :** \`${message.content}\`\n` +
            `**Auteur :** ${message.author.tag} \`(${message.author.id})\`\n` +
            `**Salon :** #${message.channel.name}`
        )
        .setTimestamp()
    );

    // ────────────────────────────────────────────────────────
    // +DmAll <message>
    // ────────────────────────────────────────────────────────
    if (command === 'dmall') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator))
            return message.reply('❌ Permission **Administrateur** requise.');

        const content = args.join(' ');
        if (!content) return message.reply('❌ Usage : `+DmAll <message>`');

        const status  = await message.reply('📨 Envoi des DMs en cours…');
        const members = await message.guild.members.fetch();
        let ok = 0, ko = 0;

        for (const [, m] of members) {
            if (m.user.bot) continue;
            try { await m.send(content); ok++; }
            catch { ko++; }
        }

        await status.edit(`✅ Terminé — **${ok}** DM(s) envoyés, **${ko}** échoués.`);
    }

    // ────────────────────────────────────────────────────────
    // +ban @user [raison]
    // ────────────────────────────────────────────────────────
    else if (command === 'ban') {
        if (!message.member.permissions.has(PermissionFlagsBits.BanMembers))
            return message.reply('❌ Permission **Bannir des membres** requise.');

        const target = message.mentions.members.first();
        if (!target)          return message.reply('❌ Usage : `+ban @membre [raison]`');
        if (!target.bannable) return message.reply('❌ Impossible de bannir ce membre (rôle trop élevé).');

        const reason = args.slice(1).join(' ') || 'Aucune raison spécifiée.';
        await target.ban({ reason });

        const embed = new EmbedBuilder()
            .setColor(0xFF0000).setTitle('🔨 Ban')
            .addFields(
                { name: 'Membre',  value: `${target.user.tag} \`(${target.id})\``, inline: true },
                { name: 'Par',     value: message.author.tag, inline: true },
                { name: 'Raison',  value: reason }
            ).setTimestamp();

        message.reply({ embeds: [embed] });
        await sendLog(message.guild, LOG.ban, embed);
    }

    // ────────────────────────────────────────────────────────
    // +tempban @user <heures>
    // ────────────────────────────────────────────────────────
    else if (command === 'tempban') {
        if (!message.member.permissions.has(PermissionFlagsBits.BanMembers))
            return message.reply('❌ Permission **Bannir des membres** requise.');

        const target = message.mentions.members.first();
        const hours  = parseFloat(args[1]);
        if (!target)                    return message.reply('❌ Usage : `+tempban @membre <heures>`');
        if (isNaN(hours) || hours <= 0) return message.reply('❌ Durée invalide. Ex : `+tempban @user 24`');
        if (!target.bannable)           return message.reply('❌ Impossible de bannir ce membre.');

        await target.ban({ reason: `Tempban ${hours}h — par ${message.author.tag}` });

        const embed = new EmbedBuilder()
            .setColor(0xFF6600).setTitle('⏱️ Temp-Ban')
            .addFields(
                { name: 'Membre', value: `${target.user.tag} \`(${target.id})\``, inline: true },
                { name: 'Par',    value: message.author.tag, inline: true },
                { name: 'Durée', value: `${hours} heure(s)` }
            ).setTimestamp();

        message.reply({ embeds: [embed] });
        await sendLog(message.guild, LOG.tempban, embed);

        if (tempBanTimers.has(target.id)) clearTimeout(tempBanTimers.get(target.id));
        tempBanTimers.set(target.id, setTimeout(async () => {
            try {
                await message.guild.bans.remove(target.id, 'Expiration du tempban automatique');
                console.log(`[TEMPBAN] Unban automatique : ${target.id}`);
            } catch { /* débanni manuellement avant expiration */ }
            tempBanTimers.delete(target.id);
        }, hours * 3_600_000));
    }

    // ────────────────────────────────────────────────────────
    // +mute @user
    // ────────────────────────────────────────────────────────
    else if (command === 'mute') {
        if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
            return message.reply('❌ Permission **Modérer les membres** requise.');

        const target = message.mentions.members.first();
        if (!target)             return message.reply('❌ Usage : `+mute @membre`');
        if (!target.moderatable) return message.reply('❌ Impossible de mute ce membre.');

        await target.timeout(28 * 24 * 3_600_000, `Mute par ${message.author.tag}`);

        const embed = new EmbedBuilder()
            .setColor(0xFFA500).setTitle('🔇 Mute')
            .addFields(
                { name: 'Membre', value: `${target.user.tag} \`(${target.id})\``, inline: true },
                { name: 'Par',    value: message.author.tag, inline: true },
                { name: 'Durée', value: '28 jours (maximum Discord)' }
            ).setTimestamp();

        message.reply({ embeds: [embed] });
        await sendLog(message.guild, LOG.mute, embed);
    }

    // ────────────────────────────────────────────────────────
    // +tempmute @user <heures>
    // ────────────────────────────────────────────────────────
    else if (command === 'tempmute') {
        if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
            return message.reply('❌ Permission **Modérer les membres** requise.');

        const target = message.mentions.members.first();
        const hours  = parseFloat(args[1]);
        if (!target)                    return message.reply('❌ Usage : `+tempmute @membre <heures>`');
        if (isNaN(hours) || hours <= 0) return message.reply('❌ Durée invalide. Ex : `+tempmute @user 2`');
        if (!target.moderatable)        return message.reply('❌ Impossible de mute ce membre.');

        const ms = Math.min(hours * 3_600_000, 28 * 24 * 3_600_000);
        await target.timeout(ms, `Tempmute ${hours}h — par ${message.author.tag}`);

        const embed = new EmbedBuilder()
            .setColor(0xFFAA00).setTitle('⏱️ Temp-Mute')
            .addFields(
                { name: 'Membre', value: `${target.user.tag} \`(${target.id})\``, inline: true },
                { name: 'Par',    value: message.author.tag, inline: true },
                { name: 'Durée', value: `${hours} heure(s)` }
            ).setTimestamp();

        message.reply({ embeds: [embed] });
        await sendLog(message.guild, LOG.tempmute, embed);
    }

    // ────────────────────────────────────────────────────────
    // +unmute @user
    // ────────────────────────────────────────────────────────
    else if (command === 'unmute') {
        if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
            return message.reply('❌ Permission **Modérer les membres** requise.');

        const target = message.mentions.members.first();
        if (!target) return message.reply('❌ Usage : `+unmute @membre`');

        await target.timeout(null, `Unmute par ${message.author.tag}`);
        message.reply(`✅ **${target.user.tag}** a été unmute.`);
    }

    // ────────────────────────────────────────────────────────
    // +unban <userId>
    // ────────────────────────────────────────────────────────
    else if (command === 'unban') {
        if (!message.member.permissions.has(PermissionFlagsBits.BanMembers))
            return message.reply('❌ Permission **Bannir des membres** requise.');

        const userId = args[0]?.replace(/[<@!>]/g, '');
        if (!userId) return message.reply('❌ Usage : `+unban <ID utilisateur>`');

        try {
            await message.guild.bans.remove(userId, `Unban par ${message.author.tag}`);
            message.reply(`✅ Utilisateur \`${userId}\` débanni.`);
        } catch {
            message.reply('❌ Cet utilisateur n\'est pas banni ou l\'ID est invalide.');
        }
    }

    // ────────────────────────────────────────────────────────
    // +lock
    // ────────────────────────────────────────────────────────
    else if (command === 'lock') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels))
            return message.reply('❌ Permission **Gérer les salons** requise.');

        await message.channel.permissionOverwrites.edit(
            message.guild.roles.everyone,
            { SendMessages: false }
        );
        message.reply('🔒 Salon verrouillé.');
    }

    // ────────────────────────────────────────────────────────
    // +unlock
    // ────────────────────────────────────────────────────────
    else if (command === 'unlock') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels))
            return message.reply('❌ Permission **Gérer les salons** requise.');

        await message.channel.permissionOverwrites.edit(
            message.guild.roles.everyone,
            { SendMessages: null }
        );
        message.reply('🔓 Salon déverrouillé.');
    }

    // ────────────────────────────────────────────────────────
    // +restore
    // ────────────────────────────────────────────────────────
    else if (command === 'restore') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels))
            return message.reply('❌ Permission **Gérer les salons** requise.');

        const ch = message.channel;

        const saved = {
            name       : ch.name,
            type       : ch.type,
            topic      : ch.topic,
            nsfw       : ch.nsfw,
            rateLimit  : ch.rateLimitPerUser,
            parentId   : ch.parentId,
            position   : ch.position,
            overwrites : ch.permissionOverwrites.cache.map(po => ({
                id    : po.id,
                type  : po.type,
                allow : po.allow.toArray(),
                deny  : po.deny.toArray(),
            })),
        };

        await message.reply('🔄 Restauration en cours…');
        await ch.delete('Commande +restore');

        try {
            const newCh = await message.guild.channels.create({
                name                : saved.name,
                type                : saved.type,
                topic               : saved.topic   ?? undefined,
                nsfw                : saved.nsfw,
                rateLimitPerUser    : saved.rateLimit,
                parent              : saved.parentId ?? undefined,
                position            : saved.position,
                permissionOverwrites: saved.overwrites,
            });
            await newCh.send('✅ Salon restauré avec succès !');
        } catch (err) {
            console.error('[RESTORE]', err);
        }
    }

    // ────────────────────────────────────────────────────────
    // +msgdel <nombre>
    // ────────────────────────────────────────────────────────
    else if (command === 'msgdel') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages))
            return message.reply('❌ Permission **Gérer les messages** requise.');

        const nb = parseInt(args[0]);
        if (isNaN(nb) || nb < 1 || nb > 100)
            return message.reply('❌ Usage : `+msgdel <1–100>`');

        try {
            await message.channel.bulkDelete(nb + 1, true);
        } catch {
            message.reply('❌ Erreur : certains messages ont peut-être plus de 14 jours (limite Discord).');
        }
    }

    // ────────────────────────────────────────────────────────
    // +snipe [@user]
    // ────────────────────────────────────────────────────────
    else if (command === 'snipe') {
        const targetUser = message.mentions.users.first();
        let entry = null;

        if (targetUser) {
            let best = null;
            for (const [, e] of snipeStore) {
                if (e.authorId === targetUser.id) {
                    if (!best || e.deletedAt > best.deletedAt) best = e;
                }
            }
            entry = best;
        } else {
            entry = snipeStore.get(message.channel.id);
        }

        if (!entry) return message.reply('❌ Aucun message supprimé récemment trouvé.');

        let desc = '';

        if (entry.context?.length) {
            desc += '**📜 Contexte (messages au-dessus)**\n';
            for (const ctx of entry.context) {
                const line = ctx.content.replace(/\n/g, ' ').slice(0, 100);
                desc += `\`${ctx.authorTag}\` : ${line}\n`;
            }
            desc += '\n━━━━━━━━━━━━━━━━━━━━━━\n\n';
        }

        desc += `**🗑️ Message supprimé par \`${entry.authorTag}\`**\n${entry.content}`;

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🔍 Snipe')
            .setDescription(desc)
            .addFields(
                { name: 'Salon',    value: `<#${entry.channelId}>`, inline: true },
                { name: 'Supprimé', value: `<t:${Math.floor(entry.deletedAt / 1000)}:R>`, inline: true }
            )
            .setTimestamp();

        message.reply({ embeds: [embed] });
        await sendLog(message.guild, LOG.snipe, embed);
    }

    // ────────────────────────────────────────────────────────
    // +kill  (accès restreint)
    // ────────────────────────────────────────────────────────
    else if (command === 'kill') {
        if (!KILL_IDS.includes(message.author.id))
            return message.reply('❌ Accès refusé.');

        await message.reply('💀 Arrêt du bot en cours…');
        client.destroy();
        process.exit(0);
    }

    // ────────────────────────────────────────────────────────
    // +safe @user
    // ────────────────────────────────────────────────────────
    else if (command === 'safe') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator))
            return message.reply('❌ Permission **Administrateur** requise.');

        const target = message.mentions.members.first();
        if (!target) return message.reply('❌ Usage : `+safe @membre`');

        if (safeList.has(target.id))
            return message.reply(`ℹ️ **${target.user.tag}** est déjà dans la whitelist RAID.`);

        safeList.add(target.id);

        const embed = new EmbedBuilder()
            .setColor(0x00FF88).setTitle('🛡️ Whitelist RAID — Ajout')
            .addFields(
                { name: 'Membre protégé', value: `${target.user.tag} \`(${target.id})\``, inline: true },
                { name: 'Ajouté par',     value: message.author.tag, inline: true }
            ).setTimestamp();

        message.reply({ embeds: [embed] });
        await sendLog(message.guild, LOG.safe, embed);
    }

    // ────────────────────────────────────────────────────────
    // +removesafe @user
    // ────────────────────────────────────────────────────────
    else if (command === 'removesafe') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator))
            return message.reply('❌ Permission **Administrateur** requise.');

        const target = message.mentions.members.first();
        if (!target) return message.reply('❌ Usage : `+removesafe @membre`');

        if (!safeList.has(target.id))
            return message.reply(`ℹ️ **${target.user.tag}** n\'est pas dans la whitelist RAID.`);

        safeList.delete(target.id);

        try {
            const safeCh = message.guild.channels.cache.get(LOG.safe);
            if (safeCh?.isTextBased()) {
                const logs = await safeCh.messages.fetch({ limit: 100 });
                const logMsg = logs.find(m =>
                    m.author.id === client.user.id &&
                    m.embeds[0]?.title?.includes('Ajout') &&
                    m.embeds[0]?.fields?.some(f => f.value.includes(`(${target.id})`))
                );
                if (logMsg) await logMsg.delete();
            }
        } catch (e) {
            console.error('[REMOVESAFE] Suppression du log :', e.message);
        }

        message.reply(`✅ **${target.user.tag}** retiré de la whitelist RAID.`);
    }

    // ────────────────────────────────────────────────────────
    // +backup from:<ID source> to:<ID destination>
    // ────────────────────────────────────────────────────────
    else if (command === 'backup') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator))
            return message.reply('❌ Permission **Administrateur** requise.');

        // ── Parsing des arguments from:/to: (insensible à l'ordre/la casse) ──
        let fromId = null, toId = null;
        for (const arg of args) {
            const fromMatch = arg.match(/^from:(\d+)$/i);
            const toMatch   = arg.match(/^to:(\d+)$/i);
            if (fromMatch) fromId = fromMatch[1];
            if (toMatch)   toId   = toMatch[1];
        }

        if (!fromId || !toId)
            return message.reply(
                '❌ Usage : `+backup from:<ID serveur source> to:<ID serveur destination>`'
            );

        if (fromId === toId)
            return message.reply(
                '❌ Le serveur source et le serveur de destination ne peuvent pas être identiques !'
            );

        const src = client.guilds.cache.get(fromId);
        if (!src)
            return message.reply(
                `❌ Serveur source introuvable (\`${fromId}\`). Le bot est-il bien présent sur ce serveur ?`
            );

        const dest = client.guilds.cache.get(toId);
        if (!dest)
            return message.reply(
                `❌ Serveur de destination introuvable (\`${toId}\`). Le bot est-il bien présent sur ce serveur ?`
            );

        const srcMember = await src.members.fetch(message.author.id).catch(() => null);
        if (!srcMember || !srcMember.permissions.has(PermissionFlagsBits.Administrator))
            return message.reply('❌ Tu dois être **Administrateur** sur le serveur source.');

        const destMember = await dest.members.fetch(message.author.id).catch(() => null);
        if (!destMember || !destMember.permissions.has(PermissionFlagsBits.Administrator))
            return message.reply('❌ Tu dois être **Administrateur** sur le serveur de destination.');

        const botMember = await dest.members.fetch(client.user.id).catch(() => null);
        if (!botMember)
            return message.reply('❌ Impossible de récupérer le rôle du bot sur le serveur de destination.');

        if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels))
            return message.reply('❌ Le bot n\'a pas la permission **Gérer les salons** sur le serveur de destination.');

        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles))
            return message.reply('❌ Le bot n\'a pas la permission **Gérer les rôles** sur le serveur de destination.');

        const replyChannel = message.channel;
        let status = await message.reply(
            `⏳ Backup en cours… **${src.name}** → **${dest.name}** (suppression puis reconstruction)`
        );

        const safeEdit = async (text) => {
            try {
                status = await status.edit(text);
            } catch (e) {
                console.warn('[BACKUP] safeEdit – edit raté, envoi nouveau message :', e.message);
                try {
                    status = await replyChannel.send(text);
                } catch (e2) {
                    console.error('[BACKUP] safeEdit – fallback aussi raté :', e2.message);
                }
            }
        };

        let rolesOk = 0, chOk = 0, delOk = 0, errs = 0;

        try {
            await safeEdit('🔄 Rafraîchissement des caches…');
            await dest.channels.fetch();
            await dest.roles.fetch();
            await src.channels.fetch();
            await src.roles.fetch();

            await safeEdit('🗑️ Suppression des salons du serveur de backup…');
            const channelsToDelete = [...dest.channels.cache.values()];
            for (const ch of channelsToDelete) {
                try { await ch.delete('Nettoyage avant backup'); delOk++; }
                catch (e) { console.error('[BACKUP] del channel:', e.message); errs++; }
            }

            await safeEdit('🗑️ Suppression des rôles du serveur de backup…');
            const rolesToDelete = [...dest.roles.cache.values()]
                .filter(r => r.id !== dest.id && !r.managed);
            for (const r of rolesToDelete) {
                try { await r.delete('Nettoyage avant backup'); }
                catch (e) { console.error('[BACKUP] del role:', e.message); errs++; }
            }

            await safeEdit('👑 Copie des rôles en cours…');
            const roleMap = new Map();
            roleMap.set(src.roles.everyone.id, dest.roles.everyone.id);

            const roles = [...src.roles.cache.values()]
                .filter(r => r.id !== src.id && !r.managed)
                .sort((a, b) => b.position - a.position);

            for (const r of roles) {
                try {
                    const newRole = await dest.roles.create({
                        name        : r.name,
                        color       : r.color,
                        hoist       : r.hoist,
                        permissions : r.permissions,
                        mentionable : r.mentionable,
                        reason      : `Backup depuis "${src.name}"`,
                    });
                    roleMap.set(r.id, newRole.id);
                    rolesOk++;
                } catch (e) { console.error('[BACKUP] create role:', e.message); errs++; }
            }

            function mapOverwrites(channel) {
                return channel.permissionOverwrites.cache
                    .map(po => {
                        const targetId = po.type === OverwriteType.Role
                            ? roleMap.get(po.id)
                            : po.id;
                        if (!targetId) return null;
                        return { id: targetId, type: po.type, allow: po.allow, deny: po.deny };
                    })
                    .filter(Boolean);
            }

            await safeEdit('📁 Copie des catégories en cours…');
            const catMap = new Map();
            const cats = [...src.channels.cache.values()]
                .filter(c => c.type === ChannelType.GuildCategory)
                .sort((a, b) => a.position - b.position);

            for (const c of cats) {
                try {
                    const newCat = await dest.channels.create({
                        name                : c.name,
                        type                : ChannelType.GuildCategory,
                        position            : c.position,
                        permissionOverwrites: mapOverwrites(c),
                        reason              : `Backup depuis "${src.name}"`,
                    });
                    catMap.set(c.id, newCat.id);
                    chOk++;
                } catch (e) { console.error('[BACKUP] create cat:', e.message); errs++; }
            }

            await safeEdit('💬 Copie des salons en cours…');
            const channels = [...src.channels.cache.values()]
                .filter(c => c.type !== ChannelType.GuildCategory)
                .sort((a, b) => a.position - b.position);

            for (const c of channels) {
                try {
                    const opts = {
                        name                : c.name,
                        type                : c.type,
                        position            : c.position,
                        permissionOverwrites: mapOverwrites(c),
                        reason              : `Backup depuis "${src.name}"`,
                    };
                    if (c.parentId && catMap.has(c.parentId)) opts.parent = catMap.get(c.parentId);
                    if (c.topic)            opts.topic            = c.topic;
                    if (c.nsfw)             opts.nsfw             = c.nsfw;
                    if (c.rateLimitPerUser) opts.rateLimitPerUser = c.rateLimitPerUser;
                    if (c.bitrate)          opts.bitrate          = c.bitrate;
                    if (c.userLimit)        opts.userLimit        = c.userLimit;

                    await dest.channels.create(opts);
                    chOk++;
                } catch (e) { console.error('[BACKUP] create channel:', e.message); errs++; }
            }

            await safeEdit(
                `✅ Backup terminé : **${src.name}** → **${dest.name}** !\n` +
                `🗑️ **${delOk}** salon(s) supprimé(s) · ` +
                `👑 **${rolesOk}** rôle(s) · ` +
                `💬 **${chOk}** salon(s)/catégorie(s) créé(s) · ` +
                `⚠️ **${errs}** erreur(s).`
            );

        } catch (err) {
            console.error('[BACKUP]', err);
            await safeEdit('❌ Erreur critique lors du backup. Vérifie les permissions du bot sur les deux serveurs.');
        }
    }

    // ────────────────────────────────────────────────────────
    // +CreateTicket Tittle:(…) Text:(…) AimedCategory:<ID>
    //               Logs:<ID> SalonText:(…) BeforeSalonID:<texte>
    // ────────────────────────────────────────────────────────
    else if (command === 'createticket') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator))
            return message.reply('❌ Permission **Administrateur** requise.');

        // Récupère tout ce qui suit "+createticket "
        const rawArgs = message.content.slice(PREFIX.length + 'createticket'.length).trim();
        const p       = parseTicketArgs(rawArgs);

        // Aliases insensibles à la casse
        const title          = p['tittle']        || p['title'];
        const mainText       = p['text'];
        const categoryId     = p['aimedcategory'] || p['aimed_category'] || p['category'];
        const logsId         = p['logs'];
        const salonText      = p['salontext']     || p['salon_text'];
        const beforeSalonId  = p['beforesalonid'] || p['before_salon_id'] || p['beforesalon'];

        // ── Validation des paramètres ──────────────────────
        const missing = [];
        if (!title)         missing.push('`Tittle:(…)`');
        if (!mainText)      missing.push('`Text:(…)`');
        if (!categoryId)    missing.push('`AimedCategory:<ID>`');
        if (!logsId)        missing.push('`Logs:<ID>`');
        if (!salonText)     missing.push('`SalonText:(…)`');
        if (!beforeSalonId) missing.push('`BeforeSalonID:<texte>`');

        if (missing.length > 0) {
            return message.reply(
                `❌ Paramètre(s) manquant(s) : ${missing.join(', ')}\n\n` +
                `**Usage :** \`+CreateTicket Tittle:(titre) Text:(texte) AimedCategory:<ID> Logs:<ID> SalonText:(texte) BeforeSalonID:<préfixe>\``
            );
        }

        // ── Vérification de la catégorie ───────────────────
        const category = message.guild.channels.cache.get(categoryId);
        if (!category || category.type !== ChannelType.GuildCategory)
            return message.reply(`❌ Catégorie introuvable avec l'ID \`${categoryId}\`. Vérifiez l'ID.`);

        // ── Vérification du salon de logs ──────────────────
        const logsCh = message.guild.channels.cache.get(logsId);
        if (!logsCh?.isTextBased())
            return message.reply(`❌ Salon de logs introuvable avec l'ID \`${logsId}\`. Vérifiez l'ID.`);

        // ── Stockage de la config ──────────────────────────
        // La clé est basée sur le timestamp pour garantir l'unicité
        const configId = `tc_${Date.now()}_${message.guild.id}`;
        ticketConfigs.set(configId, {
            categoryId,
            logsId,
            salonText,
            beforeSalonId,
            titleText : title,
            mainText,
        });

        // ── Panneau d'ouverture de ticket ──────────────────
        const panelEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(title)
            .setDescription(mainText)
            .setTimestamp()
            .setFooter({ text: `Serveur ${message.guild.name}` });

        const panelRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`ticket_open_${configId}`)
                .setLabel('🎫 Ouvrir un ticket')
                .setStyle(ButtonStyle.Primary)
        );

        await message.channel.send({ embeds: [panelEmbed], components: [panelRow] });

        // Supprime la commande pour garder le salon propre
        await message.delete().catch(() => {});

        console.log(`[TICKET] Panneau créé — configId: ${configId} — salon: #${message.channel.name}`);
    }

    // ────────────────────────────────────────────────────────
    // +help
    // ────────────────────────────────────────────────────────
    else if (command === 'help') {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('📚 Commandes disponibles')
            .setDescription('Préfixe : **`+`**\n\u200b')
            .addFields(
                {
                    name  : '👮 Modération',
                    value : [
                        '`+ban @user [raison]` — Bannir un membre',
                        '`+tempban @user <h>` — Ban temporaire (en heures)',
                        '`+unban <ID>` — Débannir un utilisateur',
                        '`+mute @user` — Mute (timeout 28j max)',
                        '`+tempmute @user <h>` — Mute temporaire (en heures)',
                        '`+unmute @user` — Retirer le mute',
                    ].join('\n'),
                },
                {
                    name  : '💬 Gestion des salons',
                    value : [
                        '`+lock` — Verrouille le salon (bloque les messages)',
                        '`+unlock` — Déverrouille le salon',
                        '`+restore` — Recrée le salon actuel à l\'identique',
                        '`+msgdel <1–100>` — Supprime X messages',
                        '`+snipe [@user]` — Remet le dernier message supprimé',
                    ].join('\n'),
                },
                {
                    name  : '🎫 Système de tickets',
                    value : [
                        '`+CreateTicket Tittle:(…) Text:(…) AimedCategory:<ID> Logs:<ID> SalonText:(…) BeforeSalonID:<préfixe>`',
                        '> Crée un panneau d\'ouverture de tickets dans le salon courant.',
                        '> **Tittle** — Titre de l\'embed du panneau',
                        '> **Text** — Description de l\'embed du panneau',
                        '> **AimedCategory** — ID de la catégorie où créer les tickets',
                        '> **Logs** — ID du salon où envoyer les transcripts à la fermeture',
                        '> **SalonText** — Texte de l\'embed affiché à l\'intérieur du ticket',
                        '> **BeforeSalonID** — Préfixe du nom du salon (ex: `ticket` → `ticket_123456789`)',
                        '',
                        'Boutons disponibles **dans chaque ticket** :',
                        '> 🙋 **Prendre en charge** — Assigne le ticket à un modérateur',
                        '> 🔒 **Fermer le ticket** — Sauvegarde le transcript et supprime le salon',
                    ].join('\n'),
                },
                {
                    name  : '⚙️ Utilitaires',
                    value : [
                        '`+DmAll <message>` — Envoie un DM à tous les membres',
                        '`+safe @user` — Ajoute à la whitelist RAID',
                        '`+removesafe @user` — Retire de la whitelist RAID',
                        '`+backup from:<ID> to:<ID>` — Sauvegarde rôles, salons & permissions d\'un serveur vers un autre',
                        '`+kill` — Éteindre le bot *(accès restreint)*',
                    ].join('\n'),
                },
                {
                    name  : '🛡️ Protection RAID (automatique)',
                    value : [
                        `Fenêtre : **10 minutes**`,
                        `Seuils avant expulsion :`,
                        `> **${RAID_LIMITS.channelDelete}** supp. de salons`,
                        `> **${RAID_LIMITS.roleDelete}** supp. de rôles`,
                        `> **${RAID_LIMITS.categoryDelete}** supp. de catégorie`,
                        `> **${RAID_LIMITS.permChange}** modif. de permissions`,
                        `Exemptés : bots, IDs propriétaires, liste \`+safe\``,
                    ].join('\n'),
                }
            )
            .setFooter({ text: client.user.tag })
            .setTimestamp();

        message.reply({ embeds: [embed] });
    }
});

// ============================================================
// 🎫 GESTIONNAIRE D'INTERACTIONS (boutons des tickets)
// ============================================================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const { customId, guild, user, channel } = interaction;

    // ────────────────────────────────────────────────────────
    // Bouton : Ouvrir un ticket
    // customId = "ticket_open_<configId>"
    // ────────────────────────────────────────────────────────
    if (customId.startsWith('ticket_open_')) {
        const configId = customId.slice('ticket_open_'.length);
        const config   = ticketConfigs.get(configId);

        if (!config) {
            return interaction.reply({
                content : '❌ Configuration introuvable. Le bot a peut-être redémarré depuis la création de ce panneau.',
                ephemeral: true,
            });
        }

        // ── Anti-doublon : un seul ticket ouvert par utilisateur ──
        const existing = [...ticketSessions.entries()].find(
            ([, s]) => s.openerId === user.id && s.guildId === guild.id
        );
        if (existing) {
            return interaction.reply({
                content  : `❌ Tu as déjà un ticket ouvert : <#${existing[0]}>`,
                ephemeral: true,
            });
        }

        // Defer pour éviter le timeout si la création prend du temps
        await interaction.deferReply({ ephemeral: true });

        try {
            // ── Sanitize le nom du salon ───────────────────
            // Discord : lettres, chiffres, tirets, underscores, max 100 chars
            const rawName    = `${config.beforeSalonId}_${user.id}`;
            const channelName = rawName
                .toLowerCase()
                .replace(/\s+/g, '-')
                .replace(/[^a-z0-9_-]/g, '')
                .slice(0, 100);

            // ── Création du salon de ticket ────────────────
            const ticketChannel = await guild.channels.create({
                name  : channelName,
                type  : ChannelType.GuildText,
                parent: config.categoryId,
                permissionOverwrites: [
                    // @everyone : invisible
                    {
                        id   : guild.roles.everyone,
                        deny : [PermissionFlagsBits.ViewChannel],
                    },
                    // Créateur du ticket : peut voir, écrire, lire
                    {
                        id   : user.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.ReadMessageHistory,
                            PermissionFlagsBits.AttachFiles,
                        ],
                    },
                    // Le bot lui-même : accès complet pour gérer le salon
                    {
                        id   : client.user.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.ReadMessageHistory,
                            PermissionFlagsBits.ManageChannels,
                            PermissionFlagsBits.ManageMessages,
                            PermissionFlagsBits.AttachFiles,
                        ],
                    },
                ],
                reason: `Ticket ouvert par ${user.tag}`,
            });

            // ── Stockage de la session ─────────────────────
            ticketSessions.set(ticketChannel.id, {
                openerId   : user.id,
                claimedBy  : null,
                guildId    : guild.id,
                configId,
                embedMsgId : null,  // renseigné juste après
            });

            // ── Embed intérieur du ticket ──────────────────
            const ticketEmbed = new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('🎫 Ticket ouvert')
                .setDescription(config.salonText)
                .addFields(
                    { name: '👤 Ouvert par', value: `${user} \`(${user.id})\``,  inline: true },
                    { name: '📌 Statut',     value: '🟢 Ouvert — en attente',    inline: true },
                )
                .setTimestamp()
                .setFooter({ text: `Ticket créé par ${user.tag}` });

            const ticketRow = buildTicketRow(false);

            const embedMsg = await ticketChannel.send({
                content : `${user} — Bienvenue dans ton ticket !`,
                embeds  : [ticketEmbed],
                components: [ticketRow],
            });

            // ── Mémorise l'ID du message embed ────────────
            ticketSessions.get(ticketChannel.id).embedMsgId = embedMsg.id;

            // ── Réponse éphémère à l'utilisateur ──────────
            await interaction.editReply({
                content: `✅ Ton ticket a été créé : ${ticketChannel}`,
            });

            console.log(`[TICKET] Ouvert — ${ticketChannel.name} par ${user.tag}`);

        } catch (e) {
            console.error('[TICKET] open :', e.message);
            await interaction.editReply({
                content: '❌ Erreur lors de la création du ticket. Vérifiez les permissions du bot dans la catégorie.',
            });
        }
    }

    // ────────────────────────────────────────────────────────
    // Bouton : Prendre en charge
    // ────────────────────────────────────────────────────────
    else if (customId === 'ticket_claim') {
        const session = ticketSessions.get(channel.id);
        if (!session) {
            return interaction.reply({
                content  : '❌ Session de ticket introuvable.',
                ephemeral: true,
            });
        }

        // ── Vérification des permissions ──────────────────
        const member = await guild.members.fetch(user.id).catch(() => null);
        if (!member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
            return interaction.reply({
                content  : '❌ Permission **Gérer les messages** requise pour prendre en charge un ticket.',
                ephemeral: true,
            });
        }

        // ── Anti-doublon claim ─────────────────────────────
        if (session.claimedBy) {
            return interaction.reply({
                content  : `❌ Ce ticket est déjà pris en charge par <@${session.claimedBy}>.`,
                ephemeral: true,
            });
        }

        session.claimedBy = user.id;

        // ── Ajoute les permissions du claimer au salon ─────
        await channel.permissionOverwrites.edit(user.id, {
            ViewChannel       : true,
            SendMessages      : true,
            ReadMessageHistory: true,
            AttachFiles       : true,
        }).catch(e => console.error('[TICKET] claim perms :', e.message));

        // ── Met à jour l'embed du ticket ───────────────────
        try {
            if (session.embedMsgId) {
                const embedMsg = await channel.messages.fetch(session.embedMsgId);
                const updatedEmbed = EmbedBuilder.from(embedMsg.embeds[0])
                    .setColor(0xFEE75C)
                    .spliceFields(1, 1, {
                        name  : '📌 Statut',
                        value : `🟡 Pris en charge par ${user}`,
                        inline: true,
                    });

                await embedMsg.edit({
                    embeds    : [updatedEmbed],
                    components: [buildTicketRow(true, user.id)],
                });
            }
        } catch (e) {
            console.error('[TICKET] claim embed update :', e.message);
        }

        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0xFEE75C)
                    .setDescription(`🙋 **${user.tag}** a pris en charge ce ticket.`)
                    .setTimestamp(),
            ],
        });

        console.log(`[TICKET] Pris en charge — ${channel.name} par ${user.tag}`);
    }

    // ────────────────────────────────────────────────────────
    // Bouton : Fermer le ticket
    // ────────────────────────────────────────────────────────
    else if (customId === 'ticket_close') {
        const session = ticketSessions.get(channel.id);
        if (!session) {
            return interaction.reply({
                content  : '❌ Session de ticket introuvable.',
                ephemeral: true,
            });
        }

        // ── Vérification : auteur du ticket ou modérateur ──
        const member    = await guild.members.fetch(user.id).catch(() => null);
        const isOpener  = user.id === session.openerId;
        const hasPerms  = member?.permissions.has(PermissionFlagsBits.ManageMessages);

        if (!isOpener && !hasPerms) {
            return interaction.reply({
                content  : '❌ Seul l\'auteur du ticket ou un modérateur peut fermer ce ticket.',
                ephemeral: true,
            });
        }

        // Réponse immédiate visible dans le ticket avant fermeture
        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setDescription(`🔒 Fermeture du ticket en cours… (sauvegarde du transcript)`)
                    .setTimestamp(),
            ],
        });

        try {
            // ── Collecte TOUS les messages du salon ────────
            // Discord limite à 100 par requête → on pagine
            let allMessages = [];
            let lastId      = null;

            while (true) {
                const opts = { limit: 100 };
                if (lastId) opts.before = lastId;
                const batch = await channel.messages.fetch(opts);
                if (batch.size === 0) break;
                allMessages = allMessages.concat([...batch.values()]);
                lastId = batch.last().id;
                if (batch.size < 100) break;
            }

            // Remet les messages dans l'ordre chronologique
            allMessages.reverse();

            // ── Formatage du transcript .txt ───────────────
            const opener  = await client.users.fetch(session.openerId).catch(() => null);
            const claimer = session.claimedBy
                ? await client.users.fetch(session.claimedBy).catch(() => null)
                : null;

            const lines = allMessages.map(m => {
                const dt          = new Date(m.createdTimestamp).toISOString();
                const attachTxt   = m.attachments.size > 0
                    ? ` [📎 ${m.attachments.map(a => a.url).join(' | ')}]`
                    : '';
                const embedTxt    = m.embeds.length > 0 ? ' [embed]' : '';
                const content     = m.content || '(aucun texte)';
                return `[${dt}] ${m.author.tag} (${m.author.id}) : ${content}${attachTxt}${embedTxt}`;
            });

            const transcript = [
                '╔══════════════════════════════════════════╗',
                `║  TRANSCRIPT DU TICKET : ${channel.name.padEnd(17)}║`,
                '╚══════════════════════════════════════════╝',
                '',
                `Serveur    : ${guild.name} (${guild.id})`,
                `Ouvert par : ${opener ? `${opener.tag} (${opener.id})` : `ID: ${session.openerId}`}`,
                `Pris en charge par : ${claimer ? `${claimer.tag} (${claimer.id})` : 'Non pris en charge'}`,
                `Fermé par  : ${user.tag} (${user.id})`,
                `Date       : ${new Date().toISOString()}`,
                `Messages   : ${allMessages.length}`,
                '',
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                '',
                ...lines,
                '',
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                `Fin du transcript — ${new Date().toISOString()}`,
            ].join('\n');

            const attachment = new AttachmentBuilder(
                Buffer.from(transcript, 'utf-8'),
                { name: `transcript_${channel.name}_${Date.now()}.txt` }
            );

            // ── Envoi dans le salon de logs ────────────────
            const config = ticketConfigs.get(session.configId);
            if (config) {
                const logsCh = guild.channels.cache.get(config.logsId);
                if (logsCh?.isTextBased()) {
                    await logsCh.send({
                        embeds: [
                            new EmbedBuilder()
                                .setColor(0xFF4444)
                                .setTitle('📁 Ticket fermé — Transcript')
                                .addFields(
                                    {
                                        name  : '🎫 Salon',
                                        value : `\`${channel.name}\``,
                                        inline: true,
                                    },
                                    {
                                        name  : '👤 Ouvert par',
                                        value : opener
                                            ? `${opener.tag} \`(${opener.id})\``
                                            : `\`${session.openerId}\``,
                                        inline: true,
                                    },
                                    {
                                        name  : '🔒 Fermé par',
                                        value : `${user.tag} \`(${user.id})\``,
                                        inline: true,
                                    },
                                    {
                                        name  : '🙋 Pris en charge par',
                                        value : claimer
                                            ? `${claimer.tag} \`(${claimer.id})\``
                                            : '*(non pris en charge)*',
                                        inline: true,
                                    },
                                    {
                                        name  : '💬 Nombre de messages',
                                        value : `${allMessages.length}`,
                                        inline: true,
                                    },
                                )
                                .setTimestamp(),
                        ],
                        files: [attachment],
                    });
                }
            }

            // ── Nettoyage + suppression du salon ──────────
            ticketSessions.delete(channel.id);
            await channel.delete(`Ticket fermé par ${user.tag}`);

            console.log(`[TICKET] Fermé — ${channel.name} par ${user.tag}`);

        } catch (e) {
            console.error('[TICKET] close :', e.message);
            // On ne peut plus envoyer dans le salon s'il a été supprimé
            // → log uniquement en console
        }
    }
});

// ============================================================
// 🔑 CONNEXION
// ============================================================
client.login(process.env.DISCORD_TOKEN);
