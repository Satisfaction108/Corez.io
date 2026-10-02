import { global } from "./global.js";

let svFilterRegionDoc = document.getElementById("serverFilterRegion");

let servers;

let serverMap = {},
tbody,
serversDocs;

let availableServers = [];

global.loadServerSelector = (serverData, text) => {
    // the duo raid is picked with the menu's SOLO | DUOS toggle and reached
    // through this host (/duo), so it never sits in this list
    serverData = (serverData || []).filter(s => s && s.mode !== "duo");
    if (!serverData.length) {
        if (text) loadEmptyServerSelector(text)
        return;
    }
    document.getElementById("startButton").disabled = false;
    servers = serverData;
    let id = location.hash.slice(1);
    if (!servers.some(server => server.id === id)) id = localStorage.getItem("lastServer");
    if (!servers.some(server => server.id === id)) id = servers[0].id;
    let serverSelector = document.getElementById("serverSelector");
      tbody = document.createElement("tbody");
      serversDocs = document.createElement("center");
    serverSelector.innerHTML = "";
    serverSelector.appendChild(tbody);
    serversDocs.id = "serverList";
    tbody.appendChild(serversDocs);
    let myServer = {
      classList: {
        contains: () => true,
      },
    };

    initializeFilter();
    // the region selector replaces the filter pills, so keep them hidden
    svFilterRegionDoc.style.display = "none";
    if (global.updateRegionSelector) global.updateRegionSelector(servers);

    servers.forEach(async (server) => {
        try {
            const tr = document.createElement("tr");
            const td1 = document.createElement("td");
            td1.textContent = `${server.region}`;
            const td2 = document.createElement("td");
            td2.classList.add("tdCenter");
            td2.textContent = `${server.gameMode}`;
            const td3 = document.createElement("td");
            if (server.maxPlayers < 1) {
                td3.textContent = `${server.players}`;
            } else {
                td3.textContent = `${server.players}/${server.maxPlayers}`;
            }
            tr.appendChild(td1);
            tr.appendChild(td2);
            tr.appendChild(td3);
            server.featured && tr.classList.add("featured");
            tr.onclick = () => {
                if (myServer.classList.contains("selected")) {
                    myServer.classList.remove("selected");
                }
                myServer = tr;
                location.hash = "#" + server.id;
                global.locationHash = location.hash;
                localStorage.setItem("lastServer", server.id);
                tr.classList.add("selected"), (global.serverAdd = server.ip);
                if (server.ip == "localhost")
                  global.serverAdd = global.serverAdd + ":" + server.port;
            };
            serversDocs.appendChild(tr);
            serverMap[server.id] = tr;
            global.serverMap[server.ip] = tr;
            if (id === server.id) myServer = tr;
            availableServers.push({ element: tr, region: server.region, gameMode: server.gameMode, id: server.id });
        } catch (e) {
            console.log(e);
        }
        if (myServer.onclick) myServer.onclick();
    });
    window.addEventListener("hashchange", () => {
        let id = location.hash.slice(1);
        if (!serverMap[id]) return;
        serverMap[id].onclick();
    });
}

let loadEmptyServerSelector = (text) => {
    let serverSelector = document.getElementById("serverSelector"),
    tbody = document.createElement("tbody");
    serverSelector.innerHTML = "";
    serverSelector.style.display = "block";
    serverSelector.appendChild(tbody);
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    td1.textContent = ``;
    const td2 = document.createElement("td");
    td2.className = "tdCenter";
    td2.textContent = `${text}`;
    const td3 = document.createElement("td");
    td3.textContent = ``;
    tr.appendChild(td1);
    tr.appendChild(td2);
    tr.appendChild(td3);
    tbody.appendChild(tr);
    document.getElementById("startButton").disabled = true;
}

let initializeFilter = () => {
    global.filters = {
        regions: {
            all: [],
            america: [],
            europe: [],
            asia: [],
            oceania: [],
            other: [],
        },
        gamemodeFilters: {
            all: [],
            normal: [],
            growth: [],
            armsRace: [],
            other: [],
            sandbox: [],
        }
    }
    let nvmText = document.createElement("td");
    nvmText.textContent = "No servers match";
    nvmText.classList.add("tdCenter");
    let noServerMatches = document.createElement("tr");
    noServerMatches.classList.add("message");
    noServerMatches.appendChild(nvmText);
    noServerMatches.style.display = "none";
    noServerMatches.style.width = "325px";
    tbody.appendChild(noServerMatches);

    for (let s of servers) {

        // entries can arrive incomplete while the game servers are still
        // booting; never let a missing field kill the whole selector
        const region = (s.region || "").toLowerCase();
        if (typeof s.gameMode !== "string") s.gameMode = s.gameMode == null ? "" : String(s.gameMode);

        global.filters.regions.all.push(s);

        if (region == "usa" || region == "us west" || region == "us central" || region == "us east") global.filters.regions.america.push(s);

        if (region == "europe") global.filters.regions.europe.push(s);

        if (region == "asia") global.filters.regions.asia.push(s);

        if (region == "oceania") global.filters.regions.oceania.push(s);

        if (
            !global.filters.regions.america.includes(s) &&
            !global.filters.regions.europe.includes(s) &&
            !global.filters.regions.asia.includes(s)
        ) {
            global.filters.regions.other.push(s);
        }

        global.filters.gamemodeFilters.all.push(s);

        if (s.gameMode.includes("Arms Race")) global.filters.gamemodeFilters.armsRace.push(s);

        else if (s.gameMode.toLowerCase().includes("growth")) global.filters.gamemodeFilters.growth.push(s);

        else if (s.gameMode.includes("Sandbox")) global.filters.gamemodeFilters.sandbox.push(s);

        else if (
            s.gameMode.includes("FFA") ||
            s.gameMode.includes("TDM") ||
            s.gameMode.includes("Duos") ||
            s.gameMode.includes("Squads") ||
            s.gameMode.includes("Wars") ||
            s.gameMode.includes("Clan Wars")
        ) {
            global.filters.gamemodeFilters.normal.push(s);
        }

        else {
            global.filters.gamemodeFilters.other.push(s);
        }
    };
    let l = [];
    let createFilter = (type, data) => {
        let r = l.length;
        l.push(data[0].filter);
        let e = document.getElementsByClassName("serverSelector");
        e[0].style.height = "170px";
        let v = null;
        for (let { name: textContent, filter: y } of data) {
            let Q = document.createElement("span");
            null == v && ((v = Q), v.classList.add("active"));
            Q.textContent = textContent;
            type.appendChild(Q);
            type.style.display = "";
            Q.addEventListener("click", () => {
                Q !== v &&
                  (v.classList.remove("active"),
                  (v = Q),
                  v.classList.add("active"));
                  l[r] = y;
                  let X = !0;
                  for (let C of availableServers) {
                    let F = !0;
                    for (let N of l) F = F && N(C);
                    C.element.style.display = F ? "" : "none";
                    X = X && !F;
                  }
                  noServerMatches.style.display = X ? "" : "none";
            });
        }
    };
    let checkFilter = (h, e) => {
        let check = false;
        e.forEach(data => {
            if (data.gameMode == h.gameMode) {
                check = true;
            }
        })
        return check;
    }
    createFilter(svFilterRegionDoc, [
        { name: "All", filter: () => !0 },
        { name: "USA", filter: (h) => {
            let e = checkFilter(h, global.filters.regions.america);
            return e;
        } },
        { name: "Europe", filter: (h) => {
            let e = checkFilter(h, global.filters.regions.europe);
            return e;
        } },
        { name: "Asia", filter: (h) => {
            let e = checkFilter(h, global.filters.regions.asia);
            return e;
        } },
        { name: "Oceania", filter: (h) => {
            let e = checkFilter(h, global.filters.regions.oceania);
            return e;
        } },
        { name: "Other", filter: (h) => {
            let e = checkFilter(h, global.filters.regions.other);
            return e;
        } },
    ]);
}

// update server row playercounts + region counts from a fresh servers list
global.refreshServerCounts = (data) => {
    if (!Array.isArray(data)) return;
    data.forEach((server) => {
        if (server && server.mode === "duo") return;   // not in this table (same host as solo)
        const tr = global.serverMap[server.ip];
        if (!tr) return;
        const td3 = tr.querySelector("td:nth-child(3)");
        if (td3) {
            td3.textContent = server.maxPlayers < 1 ? `${server.players}` : `${server.players}/${server.maxPlayers}`;
        }
    });
    if (global.updateRegionSelector) global.updateRegionSelector(data);
};