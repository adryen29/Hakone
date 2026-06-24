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

// ⬇️ Définir SECOND_SERVER_ID dans les variables d'environnement Render
const SECOND_SERVER_ID = process.env.SECOND_SERVER_ID || '';

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
    commands : '1519475032659857550',
    ban      : '1519473192652112002',
    tempban  : '1519472967640285313',
    mute     : '1519473215746080778',
    tempmute : '1519473058102902976',
    snipe    : '1519474678199095417',
    safe     : '1519473513042542724',
    raid     : '1519474527829229639',
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
// 🗂️ STOCKAGE EN MÉMOIRE
// ============================================================
const snipeStore    = new Map(); // channelId → snipe entry
const safeList      = new Set(); // userId    → whitelisté RAID
const tempBanTimers = new Map(); // userId    → timer auto-unban
const raidTracker   = new Map(); // `gId_uId` → compteurs RAID
const raidViolated  = new Set(); // `gId_uId` → déjà sanctionné (anti-double)

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
client.on('messageDelete', (message) => {
    if (!message.author || message.author.bot || !message.content) return;
    snipeStore.set(message.channel.id, {
        content     : message.content,
        authorTag   : message.author.tag,
        authorId    : message.author.id,
        channelId   : message.channel.id,
        channelName : message.channel.name,
        deletedAt   : Date.now(),
    });
});

// ============================================================
// 🎮 GESTIONNAIRE DE COMMANDES
// ============================================================
client.once('ready', () =>
    console.log(`[BOT] ✅ Connecté en tant que ${client.user.tag}`)
);

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

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🔍 Snipe')
            .setDescription(entry.content)
            .setAuthor({ name: entry.authorTag })
            .addFields(
                { name: 'Salon d\'origine', value: `#${entry.channelName} \`(${entry.channelId})\``, inline: true },
                { name: 'Supprimé',         value: `<t:${Math.floor(entry.deletedAt / 1000)}:R>`,   inline: true }
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
    // +BACKUP
    // ────────────────────────────────────────────────────────
    else if (command === 'backup') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator))
            return message.reply('❌ Permission **Administrateur** requise.');

        if (!SECOND_SERVER_ID)
            return message.reply(
                '❌ Commande échouée : la variable d\'environnement `SECOND_SERVER_ID` ' +
                'n\'est pas définie dans Render.'
            );

        const dest = client.guilds.cache.get(SECOND_SERVER_ID);
        if (!dest)
            return message.reply(
                '❌ Commande échouée : serveur de backup introuvable. ' +
                'Le bot est-il bien présent sur ce serveur ?'
            );

        const status = await message.reply('⏳ Backup en cours… (peut prendre quelques secondes)');
        const src    = message.guild;
        let rolesOk  = 0, chOk = 0, errs = 0;

        try {
            // ────────────────────────────────────────────────
            // ÉTAPE 1 — Backup des rôles
            // On construit un roleMap : ancienId → nouvelId
            // pour pouvoir mapper les permissions des salons.
            // ────────────────────────────────────────────────
            const roleMap = new Map();

            // Le rôle @everyone a toujours le même ID que le serveur
            roleMap.set(src.roles.everyone.id, dest.roles.everyone.id);

            const roles = [...src.roles.cache.values()]
                .filter(r => r.id !== src.id)               // Exclut @everyone
                .sort((a, b) => a.position - b.position);   // Du plus bas au plus haut

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
                    // Mappe l'ancien ID → le nouveau ID créé sur le serveur dest
                    roleMap.set(r.id, newRole.id);
                    rolesOk++;
                } catch { errs++; }
            }

            // ────────────────────────────────────────────────
            // Helper : convertit les permissionOverwrites
            // d'un salon source vers les IDs du serveur dest.
            //
            // Logique :
            //  • Si l'overwrite est pour un RÔLE  → on remplace l'ID via roleMap
            //  • Si l'overwrite est pour un MEMBRE → on garde le même userId
            //    (l'utilisateur peut être présent sur les deux serveurs)
            //  • Si un rôle source n'a pas pu être créé (absent du roleMap)
            //    → on l'ignore plutôt que de créer un overwrite orphelin
            // ────────────────────────────────────────────────
            function mapOverwrites(channel) {
                return channel.permissionOverwrites.cache
                    .map(po => {
                        let targetId;
                        if (po.type === OverwriteType.Role) {
                            targetId = roleMap.get(po.id); // undefined si rôle non mappé
                        } else {
                            targetId = po.id; // membre : on conserve l'userId
                        }
                        if (!targetId) return null; // rôle orphelin → on ignore
                        return {
                            id   : targetId,
                            type : po.type,
                            allow: po.allow,
                            deny : po.deny,
                        };
                    })
                    .filter(Boolean); // supprime les null
            }

            // ────────────────────────────────────────────────
            // ÉTAPE 2 — Backup des catégories
            // (en premier pour pouvoir imbriquer les salons)
            // ────────────────────────────────────────────────
            const cats   = [...src.channels.cache.values()]
                .filter(c => c.type === ChannelType.GuildCategory)
                .sort((a, b) => a.position - b.position);

            const catMap = new Map(); // ancienId → nouvelId

            for (const c of cats) {
                try {
                    const newCat = await dest.channels.create({
                        name                : c.name,
                        type                : ChannelType.GuildCategory,
                        position            : c.position,
                        permissionOverwrites: mapOverwrites(c), // ✅ permissions copiées
                        reason              : `Backup depuis "${src.name}"`,
                    });
                    catMap.set(c.id, newCat.id);
                    chOk++;
                } catch { errs++; }
            }

            // ────────────────────────────────────────────────
            // ÉTAPE 3 — Backup des salons (texte, vocal, etc.)
            // ────────────────────────────────────────────────
            const channels = [...src.channels.cache.values()]
                .filter(c => c.type !== ChannelType.GuildCategory)
                .sort((a, b) => a.position - b.position);

            for (const c of channels) {
                try {
                    const opts = {
                        name                : c.name,
                        type                : c.type,
                        position            : c.position,
                        permissionOverwrites: mapOverwrites(c), // ✅ permissions copiées
                        reason              : `Backup depuis "${src.name}"`,
                    };

                    // Imbrique dans la bonne catégorie si elle a été copiée
                    if (c.parentId && catMap.has(c.parentId))
                        opts.parent = catMap.get(c.parentId);

                    if (c.topic)            opts.topic            = c.topic;
                    if (c.nsfw)             opts.nsfw             = c.nsfw;
                    if (c.rateLimitPerUser) opts.rateLimitPerUser = c.rateLimitPerUser;
                    if (c.bitrate)          opts.bitrate          = c.bitrate;
                    if (c.userLimit)        opts.userLimit        = c.userLimit;

                    await dest.channels.create(opts);
                    chOk++;
                } catch { errs++; }
            }

            await status.edit(
                `✅ Backup terminé sur **${dest.name}** !\n` +
                `📦 **${rolesOk}** rôle(s) · **${chOk}** salon(s)/catégorie(s) créé(s) · **${errs}** erreur(s).\n` +
                `🔐 Permissions des salons copiées et mappées vers les nouveaux rôles.`
            );

        } catch (err) {
            console.error('[BACKUP]', err);
            await status.edit('❌ Erreur critique lors du backup. Vérifie les permissions du bot sur le serveur cible.');
        }
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
                    name  : '⚙️ Utilitaires',
                    value : [
                        '`+DmAll <message>` — Envoie un DM à tous les membres',
                        '`+safe @user` — Ajoute à la whitelist RAID',
                        '`+BACKUP` — Sauvegarde rôles, salons & permissions sur le serveur backup',
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
// 🔑 CONNEXION
// ============================================================
client.login(process.env.DISCORD_TOKEN);
