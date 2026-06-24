const { Client, GatewayIntentBits } = require('discord.js');

// Création d'une nouvelle instance du client Discord
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,           // Permet au bot de savoir sur quels serveurs il est
        GatewayIntentBits.GuildMessages,    // Permet au bot de voir l'activité des messages
        GatewayIntentBits.MessageContent    // OBLIGATOIRE pour lire le texte des messages (ex: "+ping")
    ]
});

// Ta variable pour le préfixe
const prefix = "+";

// Événement : Quand le bot se connecte avec succès
client.once('ready', () => {
    console.log(`Connecté avec succès en tant que ${client.user.tag}!`);
});

// Événement : Quand un message est envoyé sur le serveur
client.on('messageCreate', message => {
    // Si le message est envoyé par un bot ou s'il ne commence pas par ton préfixe, on l'ignore
    if (message.author.bot || !message.content.startsWith(prefix)) return;

    // On sépare le préfixe du reste pour obtenir le nom de la commande
    const args = message.content.slice(prefix.length).trim().split(/+/);
    const command = args.shift().toLowerCase();

    // La commande +ping
    if (command === 'ping') {
        // Calcule la latence du bot
        const pingTime = Date.now() - message.createdTimestamp;
        message.reply(`🏓 Pong ! Ma latence est de **${pingTime}ms**.`);
    }
});

// Connexion du bot à Discord (Remplace par ton jeton secret !)
// Sur Render, il faudra utiliser une variable d'environnement (ex: process.env.TOKEN)
client.login('TON_TOKEN_DISCORD_ICI');
