// What a terminal shows of what a full-screen CLI printed. Claude Code draws its screen by moving the cursor
// and writing only the cells that changed: the bytes it prints are not the text a person reads (a letter
// already on the screen is skipped, not printed again). This plays them on a grid as a terminal would, for
// the cursor moves and erasures such CLIs use; colours, modes and titles change nothing of the text.

/** The lines of the screen once `output` is played on a terminal `columns` wide, trailing spaces removed. */
export function screenOf(output: string, columns = 1000): string[] {
    const rows: string[][] = [[]];
    let row = 0;
    let column = 0;
    let saved = { row: 0, column: 0 };
    const line = (at: number) => {
        while (rows.length <= at) rows.push([]);
        return rows[at];
    };
    const chars = [...output];
    for (let at = 0; at < chars.length; at += 1) {
        const char = chars[at];
        if (char === '\u001b') {
            const next = chars[at + 1];
            if (next === '[') {
                // CSI: parameters, intermediates, a final byte.
                let end = at + 2;
                while (end < chars.length && /[0-?]/.test(chars[end])) end += 1;
                while (end < chars.length && /[ -/]/.test(chars[end])) end += 1;
                const params = chars.slice(at + 2, end).join('');
                const final = chars[end];
                const numbers = params.replace(/^[<=>?]/, '').split(';').map((value) => Number(value) || 0);
                const n = Math.max(1, numbers[0] ?? 0);
                if (!/[<=>?]/.test(params[0] ?? '')) {
                    if (final === 'A') row = Math.max(0, row - n);
                    else if (final === 'B' || final === 'E') { row += n; if (final === 'E') column = 0; }
                    else if (final === 'F') { row = Math.max(0, row - n); column = 0; }
                    else if (final === 'C') column = Math.min(columns - 1, column + n);
                    else if (final === 'D') column = Math.max(0, column - n);
                    else if (final === 'G') column = Math.min(columns - 1, n - 1);
                    else if (final === 'H' || final === 'f') { row = Math.max(0, (numbers[0] || 1) - 1); column = Math.max(0, (numbers[1] || 1) - 1); }
                    else if (final === 'K') {
                        const cells = line(row);
                        const mode = numbers[0] ?? 0;
                        if (mode === 0) cells.length = Math.min(cells.length, column);
                        else if (mode === 1) for (let cell = 0; cell <= column && cell < cells.length; cell += 1) cells[cell] = ' ';
                        else cells.length = 0;
                    } else if (final === 'J') {
                        const mode = numbers[0] ?? 0;
                        if (mode === 0) { line(row).length = Math.min(line(row).length, column); rows.length = row + 1; }
                        else if (mode === 2 || mode === 3) { rows.length = 0; rows.push([]); }
                    }
                }
                at = end;
            } else if (next === ']') {
                // OSC (a title, a hyperlink): up to BEL or ST.
                let end = at + 2;
                while (end < chars.length && chars[end] !== '\u0007' && !(chars[end] === '\u001b' && chars[end + 1] === '\\')) end += 1;
                at = chars[end] === '\u001b' ? end + 1 : end;
            } else if (next === '7') { saved = { row, column }; at += 1; }
            else if (next === '8') { ({ row, column } = saved); at += 1; }
            else if (next === '(' || next === ')' || next === '*' || next === '+') at += 2;
            else at += 1;
            continue;
        }
        if (char === '\r') { column = 0; continue; }
        if (char === '\n') { row += 1; continue; }
        if (char === '\b') { column = Math.max(0, column - 1); continue; }
        if (char < ' ' || char === '\u007f') continue;
        const cells = line(row);
        while (cells.length < column) cells.push(' ');
        cells[column] = char;
        column += 1;
        if (column >= columns) { column = 0; row += 1; }
    }
    return rows.map((cells) => cells.join('').trimEnd());
}
