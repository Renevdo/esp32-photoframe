import { describe, it, expect } from "vitest";
import { IDENTITY, rotated, mirrored, isIdentity, orientedSize } from "./orientation.js";

// A picture as rows of cells, with the two things the buttons promise to do
// to it on screen, and what orientCanvas draws for a transform (a clockwise
// turn per 90 degrees, then the mirror).
const PICTURE = [
  ["a", "b", "c"],
  ["d", "e", "f"],
];
const turnRight = (rows) => rows[0].map((_, x) => rows.map((row) => row[x]).reverse());
const turnLeft = (rows) => turnRight(turnRight(turnRight(rows)));
const mirror = (rows) => rows.map((row) => [...row].reverse());

function drawn(rows, { rotation, flipH }) {
  let out = rows;
  for (let i = 0; i < rotation / 90; i++) out = turnRight(out);
  return flipH ? mirror(out) : out;
}

const BUTTONS = {
  R: { screen: turnRight, transform: (t) => rotated(t, 1) },
  L: { screen: turnLeft, transform: (t) => rotated(t, -1) },
  M: { screen: mirror, transform: mirrored },
};

// Every sequence of up to four presses.
function sequences(maxLength) {
  const out = [];
  const grow = (prefix) => {
    if (prefix.length === maxLength) return;
    for (const key of Object.keys(BUTTONS)) {
      out.push(prefix + key);
      grow(prefix + key);
    }
  };
  grow("");
  return out;
}

describe("orientation", () => {
  it("turns the picture by a quarter turn on screen", () => {
    expect(turnRight(PICTURE)).toEqual([
      ["d", "a"],
      ["e", "b"],
      ["f", "c"],
    ]);
    expect(rotated(IDENTITY, 1)).toEqual({ rotation: 90, flipH: false });
    expect(rotated(IDENTITY, -1)).toEqual({ rotation: 270, flipH: false });
  });

  it.each(sequences(4))("presses %s as the user sees them", (presses) => {
    let screen = PICTURE;
    let transform = IDENTITY;
    for (const key of presses) {
      screen = BUTTONS[key].screen(screen);
      transform = BUTTONS[key].transform(transform);
    }
    expect(drawn(PICTURE, transform)).toEqual(screen);
  });

  it("comes back to the identity", () => {
    expect(isIdentity(IDENTITY)).toBe(true);
    expect(isIdentity(rotated(rotated(IDENTITY, 1), -1))).toBe(true);
    expect(isIdentity(mirrored(mirrored(IDENTITY)))).toBe(true);
    expect(isIdentity(rotated(IDENTITY, 4))).toBe(true);
    expect(isIdentity(rotated(IDENTITY, 1))).toBe(false);
    expect(isIdentity(mirrored(IDENTITY))).toBe(false);
  });

  it("swaps the size for odd quarter turns", () => {
    expect(orientedSize(300, 200, 0)).toEqual({ width: 300, height: 200 });
    expect(orientedSize(300, 200, 90)).toEqual({ width: 200, height: 300 });
    expect(orientedSize(300, 200, 180)).toEqual({ width: 300, height: 200 });
    expect(orientedSize(300, 200, 270)).toEqual({ width: 200, height: 300 });
  });
});
