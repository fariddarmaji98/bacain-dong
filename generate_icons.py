import zlib, struct

ACCENT = (59, 130, 246)
WHITE = (255, 255, 255)
SS = 3  # supersampling per axis, for smooth edges


def chunk(typ, data):
    return struct.pack('>I', len(data)) + typ + data + struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff)


def sample(nx, ny):
    """Colour at a point of the unit square: rounded accent tile with a white play triangle."""
    r = 0.22
    dx = max(abs(nx - 0.5) - (0.5 - r), 0.0)
    dy = max(abs(ny - 0.5) - (0.5 - r), 0.0)
    if dx * dx + dy * dy > r * r:
        return None  # outside the tile
    (ax, ay), (bx, by), (cx, cy) = (0.36, 0.26), (0.36, 0.74), (0.76, 0.50)
    d1 = (nx - bx) * (ay - by) - (ax - bx) * (ny - by)
    d2 = (nx - cx) * (by - cy) - (bx - cx) * (ny - cy)
    d3 = (nx - ax) * (cy - ay) - (cx - ax) * (ny - ay)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return WHITE if not (neg and pos) else ACCENT


def make_png(path, size):
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    c = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size)
                    if c:
                        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 1
            n = SS * SS
            if acc[3]:
                raw.extend((acc[0] // acc[3], acc[1] // acc[3], acc[2] // acc[3], 255 * acc[3] // n))
            else:
                raw.extend((0, 0, 0, 0))
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(bytes(raw)))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


for s in (16, 48, 128):
    make_png(f'icon{s}.png', s)
print('icons generated')
