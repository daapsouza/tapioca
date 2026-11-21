<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

function respond(int $status, array $payload): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function database(): PDO
{
    $dsn = getenv('MYSQL_DSN');
    $user = getenv('MYSQL_USER');
    $password = getenv('MYSQL_PASSWORD');

    if (!$dsn || $user === false || $password === false) {
        throw new RuntimeException('Configure MYSQL_DSN, MYSQL_USER e MYSQL_PASSWORD.');
    }

    return new PDO($dsn, $user, $password, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
}

function characterLength(string $value): int
{
    $matched = preg_match_all('/./us', $value);
    return $matched === false ? PHP_INT_MAX : $matched;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);

if ($method === 'GET' && $path === '/api/health') {
    respond(200, ['ok' => true]);
}

if ($method !== 'POST' || $path !== '/api/orders') {
    respond(404, ['message' => 'Endpoint não encontrado.']);
}

$input = json_decode(file_get_contents('php://input') ?: '', true);
if (!is_array($input)) {
    respond(400, ['message' => 'Envie os dados do pedido em JSON.']);
}

$product = $input['product'] ?? null;
$customerName = trim((string) ($input['customerName'] ?? ''));
$room = trim((string) ($input['room'] ?? ''));
$ingredients = $input['ingredients'] ?? null;

$allowedIngredients = [
    'tapioca' => ['Queijo', 'Presunto', 'Tomate', 'Cebola', 'Chocolate', 'Leite condensado', 'Coco'],
    'omelete' => ['Queijo', 'Presunto', 'Tomate', 'Cebola'],
];

if (!is_string($product) || !isset($allowedIngredients[$product])) {
    respond(422, ['message' => 'Selecione uma opção válida do cardápio.']);
}
if ($customerName === '' || characterLength($customerName) > 100) {
    respond(422, ['message' => 'Informe um nome com até 100 caracteres.']);
}
if ($room === '' || characterLength($room) > 20) {
    respond(422, ['message' => 'Informe o quarto com até 20 caracteres.']);
}
if (!is_array($ingredients) || count($ingredients) < 1 || count($ingredients) > 7) {
    respond(422, ['message' => 'Selecione ao menos um ingrediente válido.']);
}

$validIngredients = array_values(array_unique(array_filter(
    $ingredients,
    static fn ($value): bool => is_string($value) && in_array($value, $allowedIngredients[$product], true)
)));
if (count($validIngredients) !== count($ingredients)) {
    respond(422, ['message' => 'O pedido contém ingredientes inválidos ou repetidos.']);
}

try {
    $pdo = database();
    $pdo->beginTransaction();

    $insertOrder = $pdo->prepare(
        'INSERT INTO orders (product, customer_name, room) VALUES (:product, :customer_name, :room)'
    );
    $insertOrder->execute([
        'product' => $product,
        'customer_name' => $customerName,
        'room' => $room,
    ]);
    $orderId = (int) $pdo->lastInsertId();

    $insertIngredient = $pdo->prepare(
        'INSERT INTO order_ingredients (order_id, ingredient) VALUES (:order_id, :ingredient)'
    );
    foreach ($validIngredients as $ingredient) {
        $insertIngredient->execute(['order_id' => $orderId, 'ingredient' => $ingredient]);
    }

    $pdo->commit();
    respond(201, [
        'order' => [
            'id' => $orderId,
            'createdAt' => date(DATE_ATOM),
        ],
    ]);
} catch (RuntimeException $error) {
    if (isset($pdo) && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log('Falha ao salvar pedido: ' . $error->getMessage());
    respond(500, ['message' => 'Não foi possível salvar o pedido. Tente novamente.']);
}
