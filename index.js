import express from "express";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Bot is working 🚀");
});

app.listen(3000, () => {
  console.log("Server started");
});
