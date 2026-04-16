FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
VOLUME /data
EXPOSE 80
CMD ["npm", "start"]
