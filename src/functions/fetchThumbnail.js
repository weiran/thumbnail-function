const { app } = require("@azure/functions");
const { createThumbnailService } = require("../thumbnail");

app.http("FetchThumbnail", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: createThumbnailService(),
});
