const getFavIcon = require('get-website-favicon')

const sizeOrder = [
    '192x192', 
    '180x180', 
    '167x167', 
    '152x152', 
    '128x128', 
    '120x120', 
    '76x76', 
    '57x57'
]

module.exports = async function (context, req) {
    const query = require('url').parse(req.url, true).query
    const url = query.url
    
    if (Boolean(url) == false) {
        context.res = {
            status: 404
        }
        context.done()
        return
    }

    return getFavIcon(url).then(data => {
        let iconUrl
        const rankedIcons = data.icons.sort(icon => icon.rank)

        // look for largest sizes first
        for (let size of sizeOrder) {
            const icon = rankedIcons.find(item => item.sizes == size)
            if (icon) {
                iconUrl = icon.src
                break
            }
        }

        // then look for top ranked icons
        if (!iconUrl) {
            for (let icon of rankedIcons) {
                if (icon.src) {
                    iconUrl = icon.src
                    break
                }
            }
        }

        if (iconUrl) {
            context.res = {
                status: 301,
                headers: {
                    'Location': iconUrl
                }
            }
        } else {
            context.res = {
                status: 404
            }
        }
        context.done()
    })
}