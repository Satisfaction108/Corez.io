// Name pools for generated tanks (scripts/gen-tanks.js)
'use strict';
const w = s => s.trim().split(/\s+/);
module.exports = {
    // pairs, music and dance
    twin: w(`Tandem Duet Gemini Couplet Doublet Binary Harmony Ditto Refrain Encore Serenade Waltz Tango Polka Rumba Samba Foxtrot
        Mambo Salsa Bolero Lullaby Anthem Melody Rhapsody Sonata Cadence Tempo Banjo Fiddle Cello Viola Tuba Bongo Ukulele Mandolin
        Harp Kazoo Piccolo Clarinet Oboe Bassoon Trombone Cornet Bugle Accordion Harmonica Xylophone Marimba Glockenspiel Tambourine
        Maraca Castanet Cymbal Timpani Gong Twosome Zipper Braid Yoke Brace Mittens Crescendo Ballad Quickstep Jingle Chime Yodel
        Calypso Jive Minuet Gavotte Fandango Conga Reel Jig Hornpipe Madrigal Carol Shanty`),
    // raptors, optics and archery
    sniper: w(`Kestrel Harrier Peregrine Osprey Merlin Goshawk Buzzard Condor Hawkeye Longbow Arbalest Quiver Fletcher Bowstring Bullseye
        Spotter Monocle Telescope Periscope Sightline Crosshair Farsight Pinpoint Tracer Javelin Dart Needle Quill Sparrowhawk Falconet
        Owl Nighthawk Skylark Swift Gyrfalcon Lanner Shrike Harpy Talon Eyrie Vantage Overwatch Searchlight Optic Bifocal Glint Gleam
        Pathfinder Scout Recon Vigil Watchman Patience Hush Whisper Silhouette Horizon Skyline Longshot Faraway Kingfisher Heron Egret
        Stork Albatross Petrel Gannet Tern Puffin Lorikeet Cassowary Spectacle Eyeglass Spyhole Keyhole Squint Glimpse Peeper`),
    // weather
    machineGun: w(`Squall Monsoon Drizzle Torrent Sleet Deluge Cloudburst Downpour Shower Sprinkle Mist Drench Rainfall Raindrop Puddle
        Splash Gust Breeze Gale Flurry Snowfall Thunder Lightning Rumble Drift Frost Rime Glaze Graupel Nimbus Cumulus Stratus Cirrus
        Overcast Rainbow Sunshower Dewdrop Spritz Splatter Sizzle Fizz Pepper Popcorn Rattle Clatter Patter Pitter Waterfall Cascade
        Geyser Fountain Sprinkler Barrage Volley Salvo Fusillade Hailstone Snowflake Icicle Thaw Slush Sleetstorm Rainstorm Windchill
        Dustdevil Haboob Sirocco Mistral Chinook Bora Zonda Williwaw Simoom Levante Tramontane`),
    // compass, sky and stars
    flankGuard: w(`Compass Meridian Zenith Polaris Equinox Solstice Bearing Quadrant Sextant Azimuth Orbit Pinwheel Windrose Weathervane
        Starburst Nova Comet Aurora Eclipse Halo Corona Orion Pegasus Lyra Vega Sirius Altair Rigel Draco Cygnus Nebula Galaxy Cosmos
        Asteroid Starlight Moonbeam Sunbeam Daybreak Twilight Dusk Dawn Noon Midnight Northstar Gyroscope Carousel Whirligig Turntable
        Roundabout Ferris Sundial Hourglass Pendulum Axis Pivot Spoke Rotor Propeller Windmill Tumbler Kaleidoscope Andromeda Cassiopeia
        Perseus Capella Deneb Antares Spica Arcturus Procyon Betelgeuse Aldebaran Pollux Castor Regulus Mizar Alcor Lodestar`),
    // stone and siege
    pounder: w(`Basalt Quarry Granite Boulder Landslide Bulldozer Cannonade Bombard Culverin Trebuchet Catapult Ballista Onager Mangonel
        Avalanche Rockslide Pebble Cobble Flint Slate Marble Obsidian Quartz Gravel Bedrock Monolith Megalith Menhir Dolmen Cairn Crag
        Butte Mesa Canyon Ravine Gorge Summit Peak Ridge Bluff Cliff Tremor Quake Rumbler Thumper Clobber Wallop Thud Kaboom Howitzer
        Carronade Ironclad Hammerhead Sledge Mallet Gavel Pestle Keystone Cornerstone Sandstone Limestone Shale Pumice Jasper Agate
        Onyx Garnet Cobblestone Flagstone Gritstone Ironstone Bombardier Petard Rockfall Stonewall`),
    // branches, rivers and trees
    splitter: w(`Antler Delta Fjord Estuary Tributary Oxbow Bayou Willow Birch Aspen Cedar Juniper Cypress Maple Elm Alder Hazel Rowan
        Larch Spruce Sycamore Magnolia Baobab Mangrove Bramble Thicket Thistle Fern Bracken Clover Ivy Vine Tendril Sprout Sapling
        Seedling Acorn Pinecone Taproot Canopy Grove Orchard Coppice Hedgerow Prong Tine Spork Slingshot Dowser Crossroads Junction
        Splinter Sliver Kindling Bough Limb Burl Gnarl Timber Wildwood Linden Hawthorn Blackthorn Holly Laurel Myrtle Olive Poplar
        Redwood Rosewood Sandalwood Teak Walnut Chestnut Hickory Beech Hornbeam Wisteria Lilac Elder`),
    // forts and traps
    trap: w(`Bastion Keep Gatehouse Barbican Redoubt Citadel Rampart Battlement Parapet Moat Drawbridge Portcullis Stockade Breakwater
        Seawall Levee Embankment Trench Bunker Blockhouse Watchtower Stronghold Bailey Motte Donjon Garrison Barracks Hedge Fence
        Picket Paling Corral Paddock Lattice Trellis Barrier Blockade Roadblock Tollgate Turnstile Hurdle Caltrop Snare Mousetrap
        Trapdoor Pitfall Labyrinth Maze Warren Burrow Igloo Castle Chateau Sconce Ravelin Glacis Casemate Merlon Embrasure Postern
        Sallyport Palladium Pavilion Rotunda Gazebo Belfry Steeple Minaret Pagoda Ziggurat Acropolis Kraal Zareba Abatis Fortlet
        Outwork Hornwork Crownwork Tenaille Bartizan Machicolation`),
    // command, hives and flocks
    drone: w(`Marshal Regent Hivemind Conductor Foreman Admiral Captain Commodore Skipper Pilot Navigator Steward Herald Envoy Courier
        Chancellor Viceroy Baron Duke Monarch Sovereign Pharaoh Sultan Chieftain Puppeteer Maestro Ringmaster Taskmaster Supervisor
        Apiary Colony Flock Murmuration Starling Gaggle Covey Brood Drove Herd Shoal Pod Nestling Honeycomb Queenbee Workerbee
        Bumblebee Wasp Firefly Dragonfly Ladybug Cricket Beetle Moth Butterfly Caterpillar Termite Anthill Cicada Mayfly Gnat Midge
        Mantis Weevil Scarab Katydid Lacewing Shepherdess Drover Wrangler Herdsman Beehive Swarmking Flagship Squadron Armada Flotilla
        Convoy Caravan Parade Procession Cavalcade Entourage Retinue Tutor Mentor Coach Captainess Bosun Quartermaster Purser`),
    // auto turrets
    turret: w(`Sentry Vigilant Guardian Custodian Watchdog Beagle Terrier Collie Gargoyle Totem Obelisk Lighthouse Beacon Radar Sonar
        Antenna Gizmo Gadget Widget Doohickey Contraption Automaton Android Golem Clockwork Cogwheel Sprocket Gearbox Piston
        Crankshaft Turbine Capacitor Circuit Tinker Tinkerer Inventor Mechanic Machinist Rivet Nutcracker Jackbox Pinball Jukebox Arcade
        Rook Bishop Pawn Checkmate Domino Abacus Metronome Gyro Lookouts Robotic Servo Gimbal Ratchet Flywheel Camshaft Thermostat
        Toaster Kettle Teapot Samovar Percolator Cuckoo Carillon Orrery Astrolabe Planetarium Observatory`),
    // beasts and the forge
    smasher: w(`Rhino Anvil Tusk Grinder Sawblade Juggernaut Wrecker Meteor Rambler Charger Stampede Buffalo Bison Yak Walrus Hippo
        Mastodon Boar Warthog Armadillo Pangolin Hedgehog Porcupine Tortoise Bulldog Billygoat Moose Elk Ox Gorilla Grizzly Kodiak
        Forge Furnace Crucible Kiln Bellows Sledgehammer Ironside Steamroller Wreckingball Cannonball Dodgeball Buzzsaw Gearwheel
        Millstone Grindstone Whetstone Bowlingball Rockhopper Ironhide Stonehide Thickskin Bighorn Mouflon Ibex Muskox Wildebeest
        Gnu Okapi Tapir Capybara Wombat Badger Wolverine`),
    // when a themed pool runs dry
    spare: w(`Zephyr Mirage Oasis Lagoon Glacier Tundra Savanna Prairie Meadow Harbor Lantern Ember Cinder Blaze Flare Sparkler Firework
        Rocket Jetstream Slipstream Contrail Sonic Turbo Nitro Kite Origami Pinata Confetti Riddle Puzzle Enigma Cipher Rune Glyph
        Mosaic Fresco Canvas Easel Palette Crayon Doodle Scribble Sketch Inkwell Bookmark Gumdrop Toffee Caramel Truffle Biscuit
        Pretzel Waffle Pancake Muffin Cupcake Sundae Sherbet Sorbet Marzipan Nougat Praline Fudge Brownie Cobbler Crumble Strudel
        Eclair Macaron Churro Dumpling Noodle Pickle Radish Turnip Parsnip Pumpkin Gourd Melon Mango Papaya Kiwi Lychee Quince Plum
        Damson Apricot Nectarine Tangerine Clementine Kumquat Pomelo Citron Lime Lemon Paprika Saffron Nutmeg Cinnamon Ginger Clove
        Anise Fennel Basil Thyme Sage Oregano Parsley Chive Mint Lavender Rosemary Marigold Daisy Tulip Poppy Orchid Lotus Iris Peony
        Dahlia Azalea Begonia Camellia Gardenia Hibiscus Jasmine Primrose Snapdragon Sunflower Bluebell Foxglove Buttercup`),
    // a second spare drawer (Oct 2026 redesign): minerals, woods, birds, tools, knots and sweets
    spare2: w(`Agate Jasper Onyx Garnet Topaz Beryl Zircon Spinel Peridot Opal Jade Malachite Azurite Pyrite Galena Mica Feldspar
        Quartzite Gypsum Calcite Fluorite Hematite Magnetite Cobalt Nickel Bismuth Tungsten Iridium Osmium Cadmium Indium Gallium
        Teak Walnut Hickory Mahogany Ebony Balsa Alder Hemlock Juniper Cypress Linden Sassafras Tamarack Poplar Sycamore
        Wren Finch Robin Thrush Starling Magpie Jay Plover Curlew Dunlin Sandpiper Avocet Bittern Grebe Coot Moorhen Lapwing Siskin
        Linnet Bunting Warbler Oriole Tanager Cardinal Grosbeak Junco Towhee Vireo Kinglet Nuthatch Treecreeper Dipper Hoopoe
        Chisel Gimlet Auger Awl Bradawl Rasp Plane Spokeshave Adze Mattock Pickaxe Trowel Spade Shovel Rake Hoe Scythe Sickle
        Bowline Hitch Sheepshank Clove Halyard Lanyard Grommet Cleat Bollard Capstan Windlass Davit Gunwale Keel Rudder Tiller
        Toffee Fudge Nougat Praline Brittle Truffle Bonbon Macaron Meringue Eclair Strudel Cobbler Crumble Scone Muffin Bagel
        Pretzel Waffle Pancake Crumpet Biscuit Shortcake Gingersnap Marzipan Licorice Gumdrop Lollipop Caramel Butterscotch
        Pinto Mustang Bronco Palomino Appaloosa Clydesdale Shetland Percheron Lipizzan Arabian Pony Filly Colt Stallion
        Badger Otter Weasel Ferret Marten Stoat Mink Wolverine Raccoon Coati Kinkajou Lemur Loris Tarsier Marmoset Capuchin
        Ibex Chamois Gazelle Impala Kudu Eland Oryx Gemsbok Springbok Dikdik Okapi Tapir Wombat Quokka Numbat Bilby`),
};
// names the owner saw on wonky stage 1 designs: not reused
module.exports.retired = w(`Hurdle Caltrop Marble Hazel Gorge Marimba Mambo Collie Apiary Chorus Tripod`);
