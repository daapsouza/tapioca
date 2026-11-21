# Comanda Virtual — Tapioca para Hotel

Sistema de comandas para o café da manhã do **Hotel**, desenvolvido para operar em dois Mini PDVs Android Elgin M10. Os hóspedes criam os pedidos em um aparelho e o atendente recebe as comandas pela rede Wi-Fi local, organiza filas de preparo, imprime os pedidos e envia avisos para as TVs.

A aplicação pode funcionar totalmente sem internet. O pedido é armazenado no próprio aparelho convidado e sincronizado diretamente com o aparelho atendente pela porta TCP `38741`. A integração com TVs é opcional e depende de conexão com o servidor externo.

## Funcionalidades

### APK do hóspede

- Tela inicial em modo de cardápio com relógio, data e opções de Tapioca e Omelete.
- Identificação entre tapioca doce e salgada.
- Seleção de ingredientes e campos para nome e quarto/apartamento.
- Nome convertido para maiúsculas e quarto limitado a números.
- Confirmação visual do pedido e retorno automático ao cardápio após 3 segundos.
- Histórico local de pedidos no navegador Android.
- Serviço de sincronização Wi-Fi com código de conexão de 10 caracteres.
- Tela cheia, manutenção ativa da tela e ajuste do formulário quando o teclado é exibido.
- Tela de equipe com conexão local, configurações de impressora e visualização da comanda.

### APK do atendente

- Recepção automática dos pedidos a cada 2 segundos.
- Separação em filas de **Tapioca** e **Omelete**.
- Exibição das quatro comandas prioritárias de cada fila.
- Aba **Novos pedidos** para pedidos excedentes em ordem de chegada.
- Exibição de pedidos concluídos com opção de reabrir.
- Impressão automática na impressora integrada do M10.
- Suporte também a impressora térmica de rede.
- Reimpressão manual e diagnóstico de falhas.
- Retentativas automáticas de conexão: 1,5, 4 e 10 segundos.
- Envio opcional de aviso de pedido pronto para as TVs.
- Sincronização concluída/reaberta entre os dois aparelhos.

## Créditos do projeto

- **Autor:** Elias Santos
- **Mentor do projeto:** Elias Santos
- **Designer:** Daniel Souza

## Arquitetura

O projeto é composto por um frontend React integrado a uma camada nativa Android:

```text
src/
  App.jsx                  Interface e estado das telas
  style.css                Layout responsivo do cardápio e das comandas
  lib/orders.js            Armazenamento local dos pedidos
  lib/localOrderSync.js    Comunicação com o servidor local de pedidos
  lib/printer.js           Ponte WebView para impressão
  lib/tvReadyOrders.js     Fila e integração de avisos das TVs
  assets/                  Logo e imagens locais

android/
  app/src/main/java/...    WebView, ponte nativa e servidor TCP local
  app/src/guest/           Assets da variante Hóspede
  app/src/attendant/       Assets da variante Atendente
  app/libs/                SDK Elgin da impressora

scripts/
  build-apks.mjs           Geração dos dois APKs
  copy-android-assets.mjs  Cópia dos assets compilados

api/
  index.php                API opcional baseada em PHP e MySQL

database/
  schema.sql               Estrutura opcional do banco
```

### Tecnologias

- React 19
- Vite 6
- JavaScript ESM
- Android WebView
- Java 17
- Android SDK 35
- Gradle
- AndroidX
- SDK térmico Elgin
- PHP/PDO e MySQL como backend opcional

## Sincronização sem internet

O APK **Hóspede** inicia um servidor TCP na porta `38741`. A cada alteração, os pedidos são publicados no serviço local. O APK **Atendente** consulta o M10 do hóspede pelo IP da rede Wi-Fi e pelo código de emparelhamento exibido na tela de Impressora.

O protocolo aceita apenas os seguintes códigos de ação:

- `orders`: consulta os pedidos;
- `complete`: conclui uma comanda;
- `reopen`: reabre uma comanda concluída.

Fluxo de operação:

1. Conecte os dois M10 à mesma rede Wi-Fi.
2. Abra o APK **Hóspede** no aparelho que receberá os pedidos.
3. Em **Equipe > Impressora integrada**, anote o IP e o código de conexão.
4. Reserve o IP do aparelho no roteador para evitar mudanças.
5. Abra o APK **Atendente** no segundo aparelho.
6. Informe o IP e o código no painel de conexão.
7. Mantenha o M10 do hóspede aberto e conectado à rede.

Não compartilhe o código de emparelhamento fora da equipe autorizada. Encerrar o aplicativo ou desligar o M10 do hóspede interrompe a comunicação até que o aparelho volte a ficar disponível.

## Impressora

A aplicação usa os arquivos oficiais do SDK Elgin localizados em `android/app/libs/`:

- `e1-v1.0.6-release.aar`
- `minipdvm8.aar`

Na impressora integrada, o bridge nativo conecta ao modelo M8 com:

```text
Tipo: impressora integrada
Conexão: 6
Modelo: M8
```

Também é possível configurar uma impressora térmica de rede informando modelo, endereço IPv4 e porta TCP.

As comandas possuem largura lógica de 18 caracteres, compatível com bobina térmica de 57 mm. São usadas linhas compactas, centralização do cabeçalho, separadores, número da comanda, quarto, hóspede, produto, variante, ingredientes e tempo de preparo.

A prévia exibida no navegador representa o layout da comanda, mas a impressão real no APK é feita pelo SDK nativo Elgin. O retorno positivo do SDK confirma o envio à impressora; não confirma fisicamente a saída do papel.

Se o atendimento iniciar uma impressão após o envio do texto, o pedido permanece registrado como pendente para conferência e nova tentativa manual. Isso evita duplicatas quando o estado físico da impressão não pode ser determinado.

## Integração opcional com TVs

O APK pode enviar um aviso temporário quando um pedido é marcado como pronto. O aviso contém nome do hóspede e quarto e permanece configurado no sistema externo das TVs por 30 segundos.

Os avisos possuem uma fila local com validade máxima de 10 minutos. O envio é idempotente por meio de um identificador de evento exclusivo, evitando avisos repetidos em reconexões.

O token pode ser informado no botão **Token TV**, presente nas telas de pedidos e no APK Atendente. Sem o token, a comunicação local continua funcionando normalmente.

## Armazenamento

No frontend:

- `comanda-local-orders-v1`: pedidos locais;
- `comanda-attendant-connection-v1`: IP e código do atendente;
- `comanda-printer-config-v1`: configuração da impressora;
- `comanda-tv-ready-token-v1`: token de integração das TVs;
- `comanda-tv-ready-queue-v1`: fila de avisos pendentes;
- `comanda-attendant-auto-print-v1`: controle de impressões automáticas.

No APK Hóspede, o servidor Android usa `SharedPreferences` para manter o código de emparelhamento e o histórico compartilhado.

Limpar os dados do aplicativo ou desinstalá-lo apaga o histórico local. O sistema sincronizado pela rede não usa nuvem para pedidos.

## API PHP opcional

O diretório `api/` contém um backend opcional em PHP para registrar pedidos em MySQL.

Endpoints:

- `GET /api/health`: verifica se a API está ativa;
- `POST /api/orders`: cria um pedido e seus ingredientes.

Variáveis obrigatórias do ambiente:

```text
MYSQL_DSN
MYSQL_USER
MYSQL_PASSWORD
```

Exemplo de inicialização do banco:

```powershell
mysql -u usuario -p < database/schema.sql
```

Este backend não é utilizado pela sincronização padrão dos dois APKs. O fluxo atual dos comandantes funciona diretamente por Wi-Fi local e armazenamento no aparelho.

## Requisitos de desenvolvimento

- Windows, Linux ou macOS
- Node.js 20 ou superior
- npm
- JDK 17 ou superior
- Android SDK Platform 35
- Android SDK Build Tools 35.0.0

## Executar no navegador

```powershell
npm install
npm run dev
```

O modo navegador usa o armazenamento local do navegador. Algumas funções exclusivas dos APKs, como o SDK da impressora e o servidor TCP local, não estão disponíveis no navegador. A visualização pode usar o serviço de impressão HTTP configurado em **Equipe > Impressora**.

## Gerar os APKs

Na raiz do projeto:

```powershell
npm install
npm run apk
```

O processo compila os assets do React para cada variante e gera:

```text
android/app/build/outputs/apk/guest/debug/app-guest-debug.apk
android/app/build/outputs/apk/attendant/debug/app-attendant-debug.apk
```

Os comandos individuais de Gradle são:

```powershell
cd android
.\gradlew.bat assembleGuestDebug
.\gradlew.bat assembleAttendantDebug
```

Os arquivos das versões já compiladas também podem ser consultados em `APKs/`.

## Instalar no M10

Com a depuração USB habilitada e o aparelho autorizado:

```powershell
adb install -r android/app/build/outputs/apk/guest/debug/app-guest-debug.apk
adb install -r android/app/build/outputs/apk/attendant/debug/app-attendant-debug.apk
```

Os APKs são builds `debug` e destinam-se a testes internos. Para distribuição em produção, configure uma chave de assinatura própria e compile as variantes `release`.

## Build Web

```powershell
npm run build
npm run preview
```

Os arquivos de produção são gerados em `dist/`.

Para copiar o build atual para os assets Android principais:

```powershell
npm run build:apk-assets
```

## Estrutura de pedidos

Um pedido local contém:

- `id`: número sequencial da comanda;
- `createdAt`: data e hora em ISO;
- `customerName`: nome do hóspede;
- `room`: quarto ou apartamento;
- `product`: `Tapioca` ou `Omelete`;
- `variant`: `doce` ou `salgada`, quando aplicável;
- `ingredients`: ingredientes selecionados;
- `status`: `new`, `ready`, `delivered` ou `cancelled`;
- `printStatus`: estado da impressão;
- `printError`: mensagem da última falha;
- `tvNoticeStatus`: estado do aviso da TV.

## Solução de problemas

### O atendente não encontra o hóspede

- Confirme que os dois M10 estão na mesma rede.
- Confira o IP exibido no APK Hóspede.
- Verifique o código de emparelhamento.
- Libere a porta TCP `38741` no firewall ou roteador.
- Reserve o IP do M10 do hóspede no roteador.
- Confirme que o APK Hóspede continua aberto.

### A comanda não imprime

- Confirme que o APK Atendente foi instalado no M10.
- Execute o teste de impressora em **Equipe > Impressora**.
- Para a impressora integrada, use o modelo M8.
- Para impressora de rede, confira modelo, IPv4 e porta.
- Confira o papel térmico e o estado da bobina.
- Leia os erros exibidos no cartão da comanda.

### O aviso não chega às TVs

- Configure o token no botão **Token TV**.
- Verifique o acesso à internet.
- Confirme o endereço e o status da integração no TV Admin.
- Aguarde a tentativa da fila ou reenvie manualmente pelo pedido.

## Créditos das imagens

- **Tapioca de Trancoso**, por Byfreddygutierrez — [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Tapioca_de_trancoso_2.jpg), licenciada sob [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- **FoodOmelete.jpg**, por Renee Comet — [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:FoodOmelete.jpg), em domínio público.
- Os créditos completos também são distribuídos no aplicativo em [`public/credits.txt`](./public/credits.txt).
