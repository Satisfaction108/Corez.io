module.exports = class HashGrid {
	static stride = 1 << 16;

	cells = new Map();
	_queryTick = 0;
	constructor(cellSize) {
		this.cellSize = cellSize;
	}

	insert(entity, minX, minY, maxX, maxY) {
		const endX = maxX >> this.cellSize;
		const endY = maxY >> this.cellSize;
		for (let x = minX >> this.cellSize; x <= endX; x++) {
			for (let y = minY >> this.cellSize; y <= endY; y++) {
				const key = x + y * HashGrid.stride;
				const cell = this.cells.get(key);
				if (cell === undefined) {
					this.cells.set(key, [entity]);
				} else {
					cell.push(entity);
				}
			}
		}
	}

	query(minX, minY, maxX, maxY) {
		const cells = this.cells;
		const cellSize = this.cellSize;
		const stride = HashGrid.stride;
		const tick = ++this._queryTick;
		const output = [];

		const endX = maxX >> cellSize;
		const endY = maxY >> cellSize;
		for (let x = minX >> cellSize; x <= endX; x++) {
			for (let y = minY >> cellSize; y <= endY; y++) {
				const key = x + y * stride;
				const cell = cells.get(key);
				if (cell !== undefined) {
					for (const entity of cell) {
						if (entity.bond) continue;
						if (entity._hgTick === tick) continue;
						if (entity.minX < maxX && entity.maxX > minX && entity.minY < maxY && entity.maxY > minY) {
							entity._hgTick = tick;
							output.push(entity);
						}
					}
				}
			}
		}
		return output;
	}

	clear() {
		this._clearN = (this._clearN | 0) + 1;
		if ((this._clearN & 63) === 0) {
			this.cells.clear();
			return;
		}
		for (const cell of this.cells.values()) cell.length = 0;
	}
}