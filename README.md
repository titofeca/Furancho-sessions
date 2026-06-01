# 🍷 Furancho Sessions NFT Platform

Sistema completo para mintear NFTs en eventos. Sin crypto para los usuarios, sin complicaciones.

---

## ▶️ Arrancar el servidor

```bash
cd /Users/titofernandez/Desktop/nft
npm start
```

Luego abre en tu navegador:
- **Panel Admin**: http://localhost:3000/admin
- **Demo Nivel 1**: http://localhost:3000/claim?level=1

Contraseña admin por defecto: `furancho2024`

---

## 🔧 Configuración de Crossmint (para minteo real)

### Paso 1: Crear cuenta
1. Ve a https://crossmint.com/signin
2. Regístrate con `titofernandezc@pm.me`

### Paso 2: Crear API Key
1. En el dashboard → **Developers → API Keys**
2. Crea una clave de tipo **Server-side**
3. Activa el permiso: `nfts.create`
4. Copia la clave

### Paso 3: Crear la Colección NFT
1. Ve a **Collections → New Collection**
2. Configura:
   - Blockchain: **Polygon**
   - Token Standard: **ERC-1155**
   - Nombre: `Furancho Sessions`
3. Crea 4 tokens (uno por nivel)
4. Copia el **Collection ID**

### Paso 4: Añadir método de pago
1. Ve a **Billing → Payment Method**
2. Añade tarjeta (para pagar el gas de los usuarios)

### Paso 5: Actualizar .env
Edita el archivo `.env` en esta carpeta:

```env
CROSSMINT_API_KEY=tu_api_key_real_aqui
CROSSMINT_COLLECTION_ID=tu_collection_id_aqui
CROSSMINT_ENV=staging        # cambiar a "production" para el evento real
DEMO_MODE=false              # cambiar a false cuando tengas las keys
```

---

## 📧 Configurar Email (para mensajes a holders)

### Con Gmail:
1. Ve a tu cuenta Google → Seguridad → Contraseñas de aplicación
2. Crea una contraseña para "Mail"
3. Actualiza `.env`:

```env
EMAIL_FROM=tu_email@gmail.com
EMAIL_PASSWORD=xxxx xxxx xxxx xxxx  # la contraseña de aplicación
```

---

## 📱 QR Codes para imprimir

Una vez el servidor esté en marcha, descarga los QR desde:
- http://localhost:3000/api/qr/1/download → Nivel 1 Cautivo
- http://localhost:3000/api/qr/2/download → Nivel 2 O Cunqueiro
- http://localhost:3000/api/qr/3/download → Nivel 3 O Larpeiro
- http://localhost:3000/api/qr/4/download → Nivel 4 O Presidente

---

## 🖼️ Imágenes NFT

Las imágenes de los NFTs deben estar en `/assets/`:
- `nft_nivel1_cautivo.jpg` ✅
- `nft_nivel2_cunqueiro.jpg` (añadir)
- `nft_nivel3_larpeiro.jpg` (añadir)
- `nft_nivel4_presidente.jpg` (añadir)
- `logo.png` ✅

---

## 🌐 Despliegue en producción (Railway)

1. Ve a https://railway.app
2. Conecta tu cuenta GitHub
3. "New Project → Deploy from GitHub"
4. Añade las variables de entorno del `.env`
5. Railway te dará una URL pública (ej: `https://furancho-nft.up.railway.app`)
6. Actualiza `BASE_URL` en las variables de entorno con esa URL
7. Los QR codes apuntarán automáticamente a esa URL

---

## 🔑 Cambiar contraseña del admin

Edita `.env`:
```env
ADMIN_PASSWORD=tu_nueva_contraseña_segura
```

---

## ❓ FAQ

**¿Qué pasa si un cliente pierde su móvil?**
Solo necesita su email. En crossmint.com inicia sesión y ve todos sus NFTs.

**¿El cliente necesita instalar algo?**
No. Solo su cámara para escanear el QR y su email.

**¿Cuánto cuesta por NFT?**
En Polygon: ~$0.01-0.03 USD por NFT. Crossmint lo gestiona en fiat.

**¿Puedo ver los NFTs en OpenSea?**
Sí, todos los NFTs de Polygon aparecen en OpenSea automáticamente.
