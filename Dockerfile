FROM node:20-alpine
RUN apk add --no-cache ffmpeg python3 py3-pip && pip3 install --break-system-packages yt-dlp
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
VOLUME /data
EXPOSE 80
CMD ["npm", "start"]
