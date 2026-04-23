const { app } = require("@azure/functions");
const getFavIcon = require("get-website-favicon");

const sizeOrder = [
  "192x192",
  "180x180",
  "167x167",
  "152x152",
  "128x128",
  "120x120",
  "76x76",
  "57x57",
];

function sortByRank(left, right) {
  return (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER);
}

function pickBestIcon(icons) {
  const rankedIcons = [...icons].sort(sortByRank);

  for (const size of sizeOrder) {
    const icon = rankedIcons.find((item) => item.sizes === size);
    if (icon?.src) {
      return icon.src;
    }
  }

  return rankedIcons.find((icon) => icon.src)?.src;
}

async function fetchThumbnail(request) {
  const url = request.query.get("url");

  if (!url) {
    return { status: 404 };
  }

  const data = await getFavIcon(url);
  const iconUrl = pickBestIcon(data.icons ?? []);

  if (!iconUrl) {
    return { status: 404 };
  }

  return {
    status: 301,
    headers: {
      Location: iconUrl,
    },
  };
}

app.http("FetchThumbnail", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: fetchThumbnail,
});
