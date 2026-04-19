/** PM2: секреты только в /root/telegram-bot/.env (подхватывает dotenv в index.js) */
module.exports = {
  apps: [
    {
      name: "bot",
      script: "index.js",
      cwd: "/root/telegram-bot",
    },
  ],
};
