const { Client, GatewayIntentBits } = require('discord.js');
const http = require('http'); // <-- Ajout du module natif HTTP de Node.js

// ===================================================================
// 🌐 SERVEUR WEB FACTICE POUR RENDER
// Ce bloc sert uniquement à ouvrir un port pour empêcher Render 
// de couper le bot (obligatoire si hébergé en tant que "Web Service").
// ===================================================================
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Le bot Discord est en ligne et fonctionne !');
});
// Render attribue automatiquement un port via la variable process.env.PORT
const port = process.env.PORT || 10000;
server.listen(port, () => {
    console.log(`Faux serveur web démarré sur le port ${port} pour satisfaire Render.`);
});
// ===================================================================


// Création d'une nouvelle instance du client Discord
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,           
        GatewayIntentBits.GuildMessages,    
        GatewayIntentBits.MessageContent    
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

    // On sépare les mots par les espaces
    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // La commande +ping
    if (command === 'ping') {
        // Calcule la latence du bot
        const pingTime = Date.now() - message.createdTimestamp;
        message.reply(`🏓 Pong ! Ma latence est de **${pingTime}ms**.`);
    }
});

// Connexion sécurisée avec ta variable Render
client.login(process.env.DISCORD_TOKEN);
