const path = require("path");


/** PM2: секреты в .env в корне репозитория (подхватывает dotenv в index.js) */
module.exports = {
  apps: [
    {
      name: "telegram-bot",
      script: "index.js",
      cwd: path.join(__dirname),
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "200M",
    },
  ],
};
