from PIL import Image, ImageDraw

BG = (194, 112, 61)      # terracotta, matches --primary
SOCK = (250, 246, 239)   # cream, matches --bg
STRIPE = (47, 122, 107)  # teal accent
CUFF = (43, 36, 28)      # charcoal


def draw_sock(size):
    img = Image.new('RGBA', (size, size), BG + (255,))
    d = ImageDraw.Draw(img)
    s = size / 100.0

    def pt(x, y):
        return (x * s, y * s)

    # Sock silhouette: leg (rounded rect) + foot (rounded blob) via polygon.
    sock_pts = [
        pt(30, 12), pt(66, 12),           # top of cuff
        pt(66, 55),                        # down the leg
        pt(86, 55), pt(90, 62), pt(90, 74),
        pt(86, 86), pt(74, 90), pt(50, 90),
        pt(36, 88), pt(30, 80),
        pt(30, 12),
    ]
    d.polygon(sock_pts, fill=SOCK + (255,))

    # Cuff band
    d.rectangle([pt(30, 12), pt(66, 24)], fill=CUFF + (255,))

    # Two accent stripes across the leg
    d.rectangle([pt(30, 32), pt(66, 38)], fill=STRIPE + (255,))
    d.rectangle([pt(30, 44), pt(66, 50)], fill=STRIPE + (255,))

    # Heel accent
    d.ellipse([pt(66, 68), pt(84, 84)], fill=STRIPE + (255,))

    return img


for size in (192, 512):
    draw_sock(size).save(f'icon-{size}.png')
    print(f'icon-{size}.png written')
